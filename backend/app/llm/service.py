"""The chat turn orchestration — PLAN.md §9 "How It Works", steps 1-10.

The ordering here is contractual, not incidental:

1.  persist the user's message *first*, so it survives any later failure
2-4. load portfolio context + history, build the prompt
5-6. call the LLM; a provider failure or unparseable output short-circuits to a
     generic reply with **no** actions executed (not an HTTP error)
7.  auto-execute: all trades in order, then all watchlist changes in order,
    every entry attempted independently
8-9. build the server-generated envelope and persist the assistant turn
10. return the envelope
"""

from __future__ import annotations

import logging

from ..config import DEFAULT_USER_ID
from ..errors import ApiError
from . import history
from .client import FALLBACK_MESSAGE, complete_chat
from .context import load_portfolio_context
from .prompts import build_messages, format_history_entry
from .schemas import ActionResult, ChatProposal, ChatResponse, TradeSide, WatchlistAction

logger = logging.getLogger(__name__)


async def run_chat_turn(user_message: str, user_id: str = DEFAULT_USER_ID) -> ChatResponse:
    """Run one full chat turn and return the §9 response envelope."""
    # Step 1 — persist the user message before anything can fail.
    user_row_id = history.insert_message("user", user_message, None, user_id)

    # Steps 2-4 — context, history, prompt.
    portfolio_context = load_portfolio_context(user_id)
    past = history.recent_messages(exclude_id=user_row_id, user_id=user_id)
    formatted_history = [
        format_history_entry(entry["role"], entry["content"], entry["actions"]) for entry in past
    ]
    messages = build_messages(portfolio_context, formatted_history, user_message)

    # Steps 5-6 — call the LLM. None means "call failed or output unparseable".
    proposal = await complete_chat(messages, user_message)
    if proposal is None:
        response = ChatResponse(message=FALLBACK_MESSAGE, actions=[])
        # §9 step 9: actions is null when step 6 short-circuited.
        history.insert_message("assistant", response.message, None, user_id)
        return response

    # Step 7 — auto-execute, trades before watchlist changes.
    actions = await _execute_proposal(proposal, user_id)

    # Steps 8-9 — envelope, then persist the assistant turn with real outcomes.
    response = ChatResponse(message=proposal.message, actions=actions)
    action_dicts = [a.to_dict() for a in actions]
    history.insert_message("assistant", response.message, action_dicts or None, user_id)

    # Step 10
    return response


async def _execute_proposal(proposal: ChatProposal, user_id: str) -> list[ActionResult]:
    """Execute every proposed action independently, in the §9 fixed order.

    A failure never blocks or skips a later entry — in either array. Each action
    ends up exactly `executed` or `failed`; there is no "skipped" state (§7).
    """
    results: list[ActionResult] = []

    for trade in proposal.trades:
        results.append(await _execute_trade(trade, user_id))

    for change in proposal.watchlist_changes:
        results.append(await _apply_watchlist_change(change, user_id))

    return results


async def _execute_trade(trade, user_id: str) -> ActionResult:
    """Run one proposed trade through the same service the REST endpoint uses."""
    # Imported lazily so tests can monkeypatch the service module cleanly.
    from ..services.portfolio import execute_trade

    side = trade.side.value if isinstance(trade.side, TradeSide) else str(trade.side)
    base = {
        "type": "trade",
        "ticker": trade.ticker,
        "side": side,
        "quantity": trade.quantity,
    }

    try:
        result = await execute_trade(
            ticker=trade.ticker,
            quantity=trade.quantity,
            side=side,
            user_id=user_id,
        )
    except ApiError as exc:
        return ActionResult(**base, status="failed", error=exc.message)
    except Exception:
        logger.exception("Unexpected error executing LLM trade %s", base)
        return ActionResult(**base, status="failed", error="Trade could not be executed.")

    # The service normalizes the ticker (e.g. "aapl" -> "AAPL"); report what
    # actually traded rather than the model's raw spelling.
    base["ticker"] = _traded_ticker(result) or trade.ticker
    return ActionResult(**base, status="executed", fill_price=_fill_price(result))


async def _apply_watchlist_change(change, user_id: str) -> ActionResult:
    """Add or remove one ticker via the watchlist service."""
    from ..services import watchlist as watchlist_service

    action = (
        change.action.value if isinstance(change.action, WatchlistAction) else str(change.action)
    )
    action_type = "watchlist_add" if action == "add" else "watchlist_remove"
    base = {"type": action_type, "ticker": change.ticker}

    try:
        if action == "add":
            result = await watchlist_service.add_ticker(change.ticker, user_id=user_id)
            # The service normalizes; report the symbol it actually stored.
            base["ticker"] = str(result.get("ticker") or change.ticker)
        else:
            await watchlist_service.remove_ticker(change.ticker, user_id=user_id)
    except ApiError as exc:
        return ActionResult(**base, status="failed", error=exc.message)
    except Exception:
        logger.exception("Unexpected error applying LLM watchlist change %s", base)
        return ActionResult(**base, status="failed", error="Watchlist change could not be applied.")

    return ActionResult(**base, status="executed")


def _attr(result: object, name: str) -> object:
    """Read a field off a TradeResult dataclass, tolerating a plain dict.

    The dict branch exists so tests can stub the trade service with a simple
    mapping instead of constructing a full TradeResult.
    """
    if isinstance(result, dict):
        return result.get(name)
    return getattr(result, name, None)


def _fill_price(result: object) -> float | None:
    """The price the trade actually filled at — §9 requires it on executed trades."""
    value = _attr(result, "fill_price")
    return float(value) if value is not None else None


def _traded_ticker(result: object) -> str | None:
    value = _attr(result, "ticker")
    return str(value) if value else None
