"""Pydantic models for the LLM structured output and the chat response envelope.

Two distinct shapes live here, and PLAN.md §9 is emphatic that they must not be
confused:

* `ChatProposal` — what the *model* returns. It is a proposal, generated before
  any execution happens, so it cannot know whether a trade will pass validation.
* `ChatResponse` — what `POST /api/chat` returns. Server-generated. Its
  `actions` array is the only accurate record of what actually happened.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class TradeSide(str, Enum):
    BUY = "buy"
    SELL = "sell"


class WatchlistAction(str, Enum):
    ADD = "add"
    REMOVE = "remove"


class ProposedTrade(BaseModel):
    """A trade the LLM wants executed. Validated like any manual trade (§9)."""

    model_config = ConfigDict(extra="forbid")

    ticker: str
    side: TradeSide
    quantity: float


class ProposedWatchlistChange(BaseModel):
    """A watchlist modification the LLM wants applied (§9)."""

    model_config = ConfigDict(extra="forbid")

    ticker: str
    action: WatchlistAction


class ChatProposal(BaseModel):
    """The structured output schema the LLM is instructed to produce (§9).

    `trades` and `watchlist_changes` are optional in the sense that the model may
    omit them entirely; they default to empty lists so downstream code can always
    iterate without a None check.
    """

    model_config = ConfigDict(extra="forbid")

    message: str = Field(description="Your conversational response to the user")
    trades: list[ProposedTrade] = Field(default_factory=list)
    watchlist_changes: list[ProposedWatchlistChange] = Field(default_factory=list)


# --- Server-generated response envelope (§9 "Response Envelope") ---------------


class ActionResult(BaseModel):
    """One executed-or-failed action. `type` is "trade", "watchlist_add", or
    "watchlist_remove"; `status` is "executed" or "failed" — there is no third
    "skipped" state (§7)."""

    model_config = ConfigDict(extra="forbid")

    type: str
    ticker: str
    status: str
    side: str | None = None
    quantity: float | None = None
    fill_price: float | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        """JSON-ready dict with None fields dropped, so a watchlist action does
        not carry empty `side`/`quantity`/`fill_price` keys."""
        return {k: v for k, v in self.model_dump().items() if v is not None}


class ChatResponse(BaseModel):
    """What POST /api/chat returns and what is persisted to
    `chat_messages.actions` (§7, §9)."""

    model_config = ConfigDict(extra="forbid")

    message: str
    actions: list[ActionResult] = Field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "message": self.message,
            "actions": [a.to_dict() for a in self.actions],
        }
