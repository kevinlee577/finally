"""GET /api/health — readiness probe used by the E2E harness (PLAN.md §8, §12)."""

from __future__ import annotations

from fastapi import APIRouter

from ..config import chat_enabled
from ..state import state

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health() -> dict[str, object]:
    """Report readiness and whether chat is configured.

    `status` is "ok" only once DB startup init has completed. A missing chat key
    degrades one feature; it does not make the app unhealthy, so it affects
    `chat_enabled` only.
    """
    return {
        "status": "ok" if state.db_ready else "starting",
        "chat_enabled": chat_enabled(),
    }
