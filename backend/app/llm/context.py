"""Load the user's live portfolio state for the chat prompt (PLAN.md §9 step 2).

Deliberately thin: the §8 valuation formulas live in the portfolio and watchlist
services and are *not* reimplemented here. The chat context is built from the
same data the REST endpoints serve, so what the model is told can never drift
from what the user sees on screen.
"""

from __future__ import annotations

from ..config import DEFAULT_USER_ID
from ..services import portfolio as portfolio_service
from ..services import watchlist as watchlist_service
from .prompts import format_portfolio_context


def load_portfolio_context(user_id: str = DEFAULT_USER_ID) -> str:
    """Render the portfolio/watchlist context block handed to the LLM."""
    portfolio = portfolio_service.get_portfolio(user_id)
    watchlist = watchlist_service.get_watchlist(user_id)

    return format_portfolio_context(
        cash_balance=float(portfolio["cash_balance"]),
        total_value=float(portfolio["total_value"]),
        unrealized_pnl=float(portfolio["unrealized_pnl"]),
        positions=portfolio["positions"],
        watchlist=watchlist,
    )
