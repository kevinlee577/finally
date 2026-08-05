"""Watchlist reads and mutations (PLAN.md §6 tracking rules, §8 shapes).

Like the trade path, these functions are the shared implementation behind both
the REST routes and the LLM chat's `watchlist_changes`.
"""

from __future__ import annotations

import logging
import uuid

from ..config import DEFAULT_USER_ID
from ..db import read_connection, transaction, write_lock
from ..errors import ApiError
from ..state import state
from ..utils import normalize_ticker, round_money, utc_now_iso

logger = logging.getLogger(__name__)


def get_watchlist(user_id: str = DEFAULT_USER_ID) -> list[dict[str, object]]:
    """Watchlist entries with their latest cached price (null when unquoted)."""
    with read_connection() as conn:
        rows = conn.execute(
            "SELECT ticker, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at, ticker",
            (user_id,),
        ).fetchall()

    return [
        {
            "ticker": row["ticker"],
            "added_at": row["added_at"],
            "price": _cached_price(row["ticker"]),
        }
        for row in rows
    ]


async def add_ticker(ticker: str, user_id: str = DEFAULT_USER_ID) -> dict[str, object]:
    """Add a ticker to the watchlist and start tracking it if it isn't already.

    Raises invalid_ticker or duplicate_ticker (§8). Per §6, the market data
    source is subscribed *before* the row is inserted, and add_ticker() on the
    source is a no-op when a held position already keeps the ticker tracked.
    """
    symbol = normalize_ticker(ticker)
    if symbol is None:
        raise ApiError("invalid_ticker", f"'{ticker}' is not a valid ticker symbol.")

    async with write_lock():
        with read_connection() as conn:
            existing = conn.execute(
                "SELECT 1 FROM watchlist WHERE user_id = ? AND ticker = ?", (user_id, symbol)
            ).fetchone()
            if existing:
                raise ApiError("duplicate_ticker", f"{symbol} is already on your watchlist.")

        if state.market_source is not None and symbol not in state.market_source.get_tickers():
            await state.market_source.add_ticker(symbol)

        added_at = utc_now_iso()
        with transaction() as conn:
            conn.execute(
                "INSERT INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), user_id, symbol, added_at),
            )

    logger.info("Watchlist: added %s", symbol)
    return {"ticker": symbol, "added_at": added_at, "price": _cached_price(symbol)}


async def remove_ticker(ticker: str, user_id: str = DEFAULT_USER_ID) -> None:
    """Remove a ticker from the watchlist.

    Raises invalid_ticker or not_watchlisted (§8). Per §6, an open position in
    the ticker means we delete only the watchlist row and leave the market data
    subscription intact — remove_ticker() on the source would also evict the
    price cache entry and kill live valuation for that position.
    """
    symbol = normalize_ticker(ticker)
    if symbol is None:
        raise ApiError("invalid_ticker", f"'{ticker}' is not a valid ticker symbol.")

    async with write_lock():
        with transaction() as conn:
            deleted = conn.execute(
                "DELETE FROM watchlist WHERE user_id = ? AND ticker = ?", (user_id, symbol)
            ).rowcount
            if not deleted:
                raise ApiError("not_watchlisted", f"{symbol} is not on your watchlist.")

            held = conn.execute(
                "SELECT 1 FROM positions WHERE user_id = ? AND ticker = ? AND quantity > 0",
                (user_id, symbol),
            ).fetchone()

        if held is None and state.market_source is not None:
            await state.market_source.remove_ticker(symbol)

    logger.info("Watchlist: removed %s (position retained: %s)", symbol, held is not None)


def _cached_price(ticker: str) -> float | None:
    price = state.price_cache.get_price(ticker)
    return round_money(price) if price is not None else None
