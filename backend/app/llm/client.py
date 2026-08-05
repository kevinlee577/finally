"""LiteLLM -> OpenRouter -> Cerebras client (PLAN.md §9).

Model/provider selection follows the project's `cerebras` skill: the
`openrouter/openai/gpt-oss-120b` model, pinned to the Cerebras inference
provider via `extra_body`, with Structured Outputs used to parse the result.

`complete_chat` never raises for provider/parse failures — per §9 step 6 those
degrade into a normal chat turn carrying the generic fallback message, not an
HTTP error. It returns `None` to signal "could not get a usable proposal".
"""

from __future__ import annotations

import asyncio
import logging

from litellm import completion

from ..config import llm_mock_enabled
from .mock import mock_completion
from .schemas import ChatProposal

logger = logging.getLogger(__name__)

MODEL = "openrouter/openai/gpt-oss-120b"
EXTRA_BODY = {"provider": {"order": ["cerebras"]}}
REASONING_EFFORT = "low"

# §9: "Sorry, I had trouble processing that — please try again"
FALLBACK_MESSAGE = "Sorry, I had trouble processing that — please try again."


def _call_llm_sync(messages: list[dict]) -> str:
    """Blocking LiteLLM call. Runs in a worker thread via `complete_chat`."""
    response = completion(
        model=MODEL,
        messages=messages,
        response_format=ChatProposal,
        reasoning_effort=REASONING_EFFORT,
        extra_body=EXTRA_BODY,
    )
    return response.choices[0].message.content


async def complete_chat(messages: list[dict], user_message: str) -> ChatProposal | None:
    """Get a `ChatProposal` from the LLM, or None if the call or parse failed.

    In `LLM_MOCK=true` mode this bypasses the network entirely and serves the
    deterministic fixture table, including its intentionally-malformed fixture.
    """
    try:
        if llm_mock_enabled():
            raw = mock_completion(user_message)
        else:
            # litellm's completion() is synchronous and does blocking network
            # I/O; offload it so the event loop keeps serving SSE streams.
            raw = await asyncio.to_thread(_call_llm_sync, messages)
    except Exception:
        logger.exception("LLM call failed; falling back to generic chat reply")
        return None

    if not raw:
        logger.error("LLM returned an empty response body")
        return None

    try:
        return ChatProposal.model_validate_json(raw)
    except Exception:
        logger.exception("LLM returned unparseable structured output: %r", raw[:500])
        return None
