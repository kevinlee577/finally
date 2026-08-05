"""Factory for creating market data sources."""

from __future__ import annotations

import logging
import os

from .cache import PriceCache
from .interface import MarketDataSource
from .massive_client import MassiveDataSource
from .simulator import SimulatorDataSource

logger = logging.getLogger(__name__)


def create_market_data_source(
    price_cache: PriceCache,
    tick_seconds: float | None = None,
) -> MarketDataSource:
    """Create the appropriate market data source based on environment variables.

    - MASSIVE_API_KEY set and non-empty → MassiveDataSource (real market data)
    - Otherwise → SimulatorDataSource (GBM simulation)

    `tick_seconds` overrides the simulator's update interval (MARKET_TICK_SECONDS,
    per PLAN.md §12, so E2E tests can run sub-second). It does not apply to
    Massive, whose poll interval is dictated by the provider's rate limits.

    Returns an unstarted source. Caller must await source.start(tickers).
    """
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()

    if api_key:
        logger.info("Market data source: Massive API (real data)")
        return MassiveDataSource(api_key=api_key, price_cache=price_cache)
    else:
        logger.info("Market data source: GBM Simulator")
        if tick_seconds is None:
            return SimulatorDataSource(price_cache=price_cache)
        return SimulatorDataSource(price_cache=price_cache, update_interval=tick_seconds)
