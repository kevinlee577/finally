"""Process-wide runtime singletons shared by the API routers and services.

The market data source and price cache are created once in the FastAPI lifespan
hook and read from here by trade/watchlist services, which must be able to call
`add_ticker()` / `remove_ticker()` without importing main.py (circular import).
"""

from __future__ import annotations

from .market import MarketDataSource, PriceCache


class AppState:
    """Mutable holder for objects whose lifetime matches the app process."""

    def __init__(self) -> None:
        self.price_cache: PriceCache = PriceCache()
        self.market_source: MarketDataSource | None = None
        self.db_ready: bool = False

    def reset(self) -> None:
        """Drop runtime objects. Used by tests between cases."""
        self.price_cache = PriceCache()
        self.market_source = None
        self.db_ready = False


state = AppState()
