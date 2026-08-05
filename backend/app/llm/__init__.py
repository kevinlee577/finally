"""LLM chat integration (PLAN.md §9).

Public surface:

    from app.llm import ChatProposal, run_chat_turn, MOCK_FIXTURES

`run_chat_turn` implements the full 10-step flow from PLAN.md §9 and is what
`app/api/chat.py` calls. Everything else here is a building block for it.
"""

from __future__ import annotations

from .mock import MOCK_FIXTURES, MOCK_TRIGGER_PHRASES, mock_completion
from .schemas import (
    ChatProposal,
    ChatResponse,
    ProposedTrade,
    ProposedWatchlistChange,
    TradeSide,
    WatchlistAction,
)
from .service import run_chat_turn

__all__ = [
    "MOCK_FIXTURES",
    "MOCK_TRIGGER_PHRASES",
    "ChatProposal",
    "ChatResponse",
    "ProposedTrade",
    "ProposedWatchlistChange",
    "TradeSide",
    "WatchlistAction",
    "mock_completion",
    "run_chat_turn",
]
