"""POST /api/chat — the AI assistant endpoint (PLAN.md §8, §9).

The only chat failure mode that is an HTTP error is `chat_unavailable` (503, no
API key configured). Everything past that point — provider outage, malformed
model output, a trade that fails validation — degrades in-band as a normal 200
chat turn, per §9.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import chat_enabled
from ..errors import ApiError
from ..llm import run_chat_turn

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    """§9: request body is {"message": "<user text>"}."""

    message: str = Field(min_length=1)


@router.post("/chat")
async def post_chat(payload: ChatRequest) -> dict:
    if not chat_enabled():
        # §5/§8: 503 with the configuration-specific message.
        raise ApiError("chat_unavailable")

    response = await run_chat_turn(payload.message)
    return response.to_dict()
