"""Watchlist endpoints (PLAN.md §8).

GET    /api/watchlist          - tickers with latest prices
POST   /api/watchlist          - add a ticker (201)
DELETE /api/watchlist/{ticker} - remove a ticker (204, no body)
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from ..services import watchlist as watchlist_service

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


class WatchlistAddRequest(BaseModel):
    ticker: str


@router.get("")
async def read_watchlist() -> dict[str, object]:
    return {"watchlist": watchlist_service.get_watchlist()}


@router.post("", status_code=status.HTTP_201_CREATED)
async def add_to_watchlist(request: WatchlistAddRequest) -> dict[str, object]:
    return await watchlist_service.add_ticker(request.ticker)


@router.delete("/{ticker}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_from_watchlist(ticker: str) -> Response:
    await watchlist_service.remove_ticker(ticker)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
