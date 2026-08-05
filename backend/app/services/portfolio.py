"""Portfolio reads and the shared trade-execution path (PLAN.md §7, §8).

`execute_trade()` is the single entry point for every market order, whether it
came from POST /api/portfolio/trade or from an LLM-proposed trade in the chat
flow. It performs all validation, runs one BEGIN IMMEDIATE transaction under the
process-wide write lock, and maintains the §6 ticker tracking set.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from dataclasses import dataclass, field

from ..config import DEFAULT_USER_ID
from ..db import read_connection, transaction, write_lock
from ..errors import ApiError
from ..state import state
from ..utils import normalize_ticker, round_money, round_quantity, utc_now_iso
from .snapshots import compute_total_value, insert_snapshot

logger = logging.getLogger(__name__)

VALID_SIDES = ("buy", "sell")

# Guards float comparisons in cash/share sufficiency checks so that a "sell all"
# or "spend exactly my balance" order is not rejected by representation noise.
_EPSILON = 1e-9


@dataclass(frozen=True)
class TradeResult:
    """Outcome of one successfully executed trade."""

    ticker: str
    side: str
    quantity: float
    fill_price: float
    cash_balance: float
    executed_at: str
    total_value: float
    # None when the trade closed the position entirely.
    position: dict[str, float | str] | None = field(default=None)

    def to_dict(self) -> dict[str, object]:
        return {
            "ticker": self.ticker,
            "side": self.side,
            "quantity": self.quantity,
            "fill_price": self.fill_price,
            "cash_balance": self.cash_balance,
            "executed_at": self.executed_at,
            "total_value": self.total_value,
            "position": self.position,
        }


async def execute_trade(
    ticker: str,
    quantity: float,
    side: str,
    user_id: str = DEFAULT_USER_ID,
) -> TradeResult:
    """Validate and execute a single market order at the current cached price.

    Raises ApiError with a §8 code on any validation failure:
    invalid_ticker, invalid_side, validation_error, quote_unavailable,
    insufficient_cash, no_position, insufficient_shares.
    """
    symbol = normalize_ticker(ticker)
    if symbol is None:
        raise ApiError("invalid_ticker", f"'{ticker}' is not a valid ticker symbol.")

    normalized_side = side.strip().lower() if isinstance(side, str) else ""
    if normalized_side not in VALID_SIDES:
        raise ApiError("invalid_side", f"Side must be 'buy' or 'sell', got '{side}'.")

    qty = _validate_quantity(quantity)
    price = await _require_quote(symbol)

    async with write_lock():
        with transaction() as conn:
            result = _apply_trade(conn, symbol, qty, normalized_side, price, user_id)

    await _reconcile_tracking(symbol, closed=result.position is None, user_id=user_id)
    logger.info(
        "Trade executed: %s %s %s @ %.2f (cash now %.2f)",
        normalized_side,
        qty,
        symbol,
        price,
        result.cash_balance,
    )
    return result


def get_portfolio(user_id: str = DEFAULT_USER_ID) -> dict[str, object]:
    """Cash, open positions with live P&L, total value and aggregate P&L (§8)."""
    with read_connection() as conn:
        profile = conn.execute(
            "SELECT cash_balance FROM users_profile WHERE id = ?", (user_id,)
        ).fetchone()
        cash_balance = round_money(float(profile["cash_balance"])) if profile else 0.0

        rows = conn.execute(
            "SELECT ticker, quantity, avg_cost FROM positions"
            " WHERE user_id = ? AND quantity > 0 ORDER BY ticker",
            (user_id,),
        ).fetchall()

    positions = [_position_view(row) for row in rows]
    total_value = round_money(cash_balance + sum(p["market_value"] for p in positions))
    unrealized_pnl = round_money(sum(p["unrealized_pnl"] for p in positions))

    return {
        "cash_balance": cash_balance,
        "total_value": total_value,
        "unrealized_pnl": unrealized_pnl,
        "positions": positions,
    }


def _position_view(row: sqlite3.Row) -> dict[str, object]:
    """One position with §8's metric formulas applied against the live price."""
    quantity = round_quantity(float(row["quantity"]))
    avg_cost = round_money(float(row["avg_cost"]))
    cached = state.price_cache.get_price(row["ticker"])
    # Unpriceable positions fall back to cost basis, matching the snapshot rule.
    current_price = round_money(cached) if cached is not None else avg_cost

    return {
        "ticker": row["ticker"],
        "quantity": quantity,
        "avg_cost": avg_cost,
        "current_price": current_price,
        "market_value": round_money(quantity * current_price),
        "unrealized_pnl": round_money((current_price - avg_cost) * quantity),
        "change_percent": round_money((current_price - avg_cost) / avg_cost * 100),
    }


def _validate_quantity(quantity: object) -> float:
    """Quantity must be a positive, finite number (§8 validation_error)."""
    if isinstance(quantity, bool) or not isinstance(quantity, (int, float)):
        raise ApiError("validation_error", "quantity must be a number.")
    qty = round_quantity(float(quantity))
    if qty != qty or qty in (float("inf"), float("-inf")):
        raise ApiError("validation_error", "quantity must be a finite number.")
    if qty <= 0:
        raise ApiError("validation_error", "quantity must be greater than zero.")
    return qty


async def _require_quote(symbol: str) -> float:
    """Current price for `symbol`, or reject with quote_unavailable (§6).

    A trade for an untracked symbol is allowed, but it still needs a price. We
    subscribe the ticker so a retry moments later can fill, then reject now
    rather than blocking the request until a quote arrives.
    """
    price = state.price_cache.get_price(symbol)
    if price is not None:
        return round_money(price)

    if state.market_source is not None:
        await state.market_source.add_ticker(symbol)
        price = state.price_cache.get_price(symbol)
        if price is not None:
            return round_money(price)

    raise ApiError(
        "quote_unavailable",
        f"No price available for {symbol} yet — it is now being tracked, try again shortly.",
    )


def _apply_trade(
    conn: sqlite3.Connection,
    symbol: str,
    qty: float,
    side: str,
    price: float,
    user_id: str,
) -> TradeResult:
    """The atomic body of a trade. Runs inside BEGIN IMMEDIATE.

    Updates cash, upserts or deletes the position, appends the trade row, and
    records the resulting snapshot — all committing or rolling back together.
    """
    profile = conn.execute(
        "SELECT cash_balance FROM users_profile WHERE id = ?", (user_id,)
    ).fetchone()
    if profile is None:
        raise ApiError("internal_error", "User profile is missing.")
    cash_balance = float(profile["cash_balance"])

    position = conn.execute(
        "SELECT id, quantity, avg_cost FROM positions WHERE user_id = ? AND ticker = ?",
        (user_id, symbol),
    ).fetchone()

    if side == "buy":
        new_cash, new_quantity, new_avg_cost = _apply_buy(cash_balance, position, qty, price)
    else:
        new_cash, new_quantity, new_avg_cost = _apply_sell(
            cash_balance, position, qty, price, symbol
        )

    conn.execute(
        "UPDATE users_profile SET cash_balance = ? WHERE id = ?",
        (new_cash, user_id),
    )

    now = utc_now_iso()
    if new_quantity == 0:
        conn.execute(
            "DELETE FROM positions WHERE user_id = ? AND ticker = ?", (user_id, symbol)
        )
        position_view: dict[str, float | str] | None = None
    else:
        conn.execute(
            """
            INSERT INTO positions (id, user_id, ticker, quantity, avg_cost, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id, ticker) DO UPDATE SET
                quantity = excluded.quantity,
                avg_cost = excluded.avg_cost,
                updated_at = excluded.updated_at
            """,
            (str(uuid.uuid4()), user_id, symbol, new_quantity, new_avg_cost, now),
        )
        position_view = {
            "ticker": symbol,
            "quantity": new_quantity,
            "avg_cost": new_avg_cost,
            "updated_at": now,
        }

    conn.execute(
        "INSERT INTO trades (id, user_id, ticker, side, quantity, price, executed_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), user_id, symbol, side, qty, price, now),
    )

    total_value = compute_total_value(conn, user_id)
    insert_snapshot(conn, total_value, user_id)

    return TradeResult(
        ticker=symbol,
        side=side,
        quantity=qty,
        fill_price=price,
        cash_balance=new_cash,
        executed_at=now,
        total_value=total_value,
        position=position_view,
    )


def _apply_buy(
    cash_balance: float,
    position: sqlite3.Row | None,
    qty: float,
    price: float,
) -> tuple[float, float, float]:
    """Returns (new_cash, new_quantity, new_avg_cost) for a buy."""
    cost = round_money(qty * price)
    if cost > cash_balance + _EPSILON:
        raise ApiError(
            "insufficient_cash",
            f"This purchase costs ${cost:,.2f} but you only have ${cash_balance:,.2f}.",
        )

    held = float(position["quantity"]) if position else 0.0
    held_cost = float(position["avg_cost"]) * held if position else 0.0

    new_quantity = round_quantity(held + qty)
    # Weighted-average cost basis across the prior holding and this fill.
    new_avg_cost = round_money((held_cost + qty * price) / new_quantity)
    return round_money(cash_balance - cost), new_quantity, new_avg_cost


def _apply_sell(
    cash_balance: float,
    position: sqlite3.Row | None,
    qty: float,
    price: float,
    symbol: str,
) -> tuple[float, float, float]:
    """Returns (new_cash, new_quantity, new_avg_cost) for a sell.

    Selling never changes the cost basis; proceeds land in cash and any realized
    gain or loss is implicit in the resulting balance.
    """
    if position is None:
        raise ApiError("no_position", f"You have no open position in {symbol}.")

    held = round_quantity(float(position["quantity"]))
    if qty > held + _EPSILON:
        raise ApiError(
            "insufficient_shares",
            f"You hold {held:g} shares of {symbol} but tried to sell {qty:g}.",
        )

    avg_cost = round_money(float(position["avg_cost"]))
    proceeds = round_money(qty * price)
    # Clamp so an exact "sell all" zeroes out rather than leaving float residue.
    new_quantity = round_quantity(max(held - qty, 0.0))
    return round_money(cash_balance + proceeds), new_quantity, avg_cost


async def _reconcile_tracking(symbol: str, closed: bool, user_id: str) -> None:
    """Keep the market data source's ticker set in sync after a trade (§6).

    A buy of a previously untracked symbol subscribes it so the position stays
    priceable. A trade that zeroes a position unsubscribes it *only* if the
    ticker is also no longer watchlisted.
    """
    source = state.market_source
    if source is None:
        return

    with read_connection() as conn:
        watchlisted = (
            conn.execute(
                "SELECT 1 FROM watchlist WHERE user_id = ? AND ticker = ?", (user_id, symbol)
            ).fetchone()
            is not None
        )

    if closed:
        if not watchlisted:
            await source.remove_ticker(symbol)
        return

    if symbol not in source.get_tickers():
        await source.add_ticker(symbol)
