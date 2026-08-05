"""Portfolio endpoints (PLAN.md §8).

GET  /api/portfolio          - cash, positions with P&L, total value
POST /api/portfolio/trade    - execute a market order
GET  /api/portfolio/history  - value snapshots for the P&L chart
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..services import portfolio as portfolio_service
from ..services import snapshots as snapshot_service

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


class TradeRequest(BaseModel):
    """Body of POST /api/portfolio/trade.

    `side` is a plain str rather than an enum so an unrecognized value produces
    §8's `invalid_side` (400) from the service, not pydantic's generic 422.
    """

    ticker: str
    quantity: float
    side: str


@router.get("")
async def read_portfolio() -> dict[str, object]:
    return portfolio_service.get_portfolio()


@router.post("/trade")
async def create_trade(request: TradeRequest) -> dict[str, object]:
    """Execute a market order, filled instantly at the current cached price."""
    result = await portfolio_service.execute_trade(
        ticker=request.ticker,
        quantity=request.quantity,
        side=request.side,
    )
    return result.to_dict()


@router.get("/history")
async def read_history() -> dict[str, object]:
    return {"snapshots": snapshot_service.list_snapshots()}
