# Market Data Backend — Detailed Design

Implementation-ready design for the FinAlly market data subsystem: the unified
`MarketDataSource` interface, the in-memory `PriceCache`, the GBM simulator, the
Massive API client, the SSE streaming endpoint, and the integration contract
that the (not-yet-built) watchlist/portfolio/chat routes must follow when
they land on top of this module.

**Status of the code in this document:** §§1–10 document `backend/app/market/`
exactly as shipped (verified against source, 2026-08-03; 73 tests passing).
§11 ("Integration Contract") is forward-looking — it specifies how downstream
routes must call into this already-built module to satisfy `planning/PLAN.md`
§6 and §8, since those sections were resolved after this module was frozen.
Treat §§1–10 as "this is what exists," and §11 as "this is what must be built
against it."

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Data Model — `models.py`](#3-data-model)
4. [Price Cache — `cache.py`](#4-price-cache)
5. [Abstract Interface — `interface.py`](#5-abstract-interface)
6. [Seed Prices & Ticker Parameters — `seed_prices.py`](#6-seed-prices--ticker-parameters)
7. [GBM Simulator — `simulator.py`](#7-gbm-simulator)
8. [Massive API Client — `massive_client.py`](#8-massive-api-client)
9. [Factory — `factory.py`](#9-factory)
10. [SSE Streaming Endpoint — `stream.py`](#10-sse-streaming-endpoint)
11. [Integration Contract for Downstream Routes](#11-integration-contract-for-downstream-routes)
12. [FastAPI Lifecycle Integration](#12-fastapi-lifecycle-integration)
13. [Testing Strategy](#13-testing-strategy)
14. [Configuration Summary](#14-configuration-summary)

---

## 1. Architecture Overview

```
                     ┌─────────────────────────┐
                     │   MarketDataSource (ABC) │
                     └────────────┬────────────┘
                    ┌──────────────┴──────────────┐
          ┌─────────▼─────────┐         ┌─────────▼──────────┐
          │ SimulatorDataSource│         │  MassiveDataSource  │
          │  (GBM, default)    │         │ (Polygon.io poller) │
          └─────────┬─────────┘         └─────────┬──────────┘
                    │        writes latest price    │
                    └───────────────┬───────────────┘
                                    ▼
                          ┌───────────────────┐
                          │     PriceCache     │  (thread-safe, in-memory)
                          └─────────┬─────────┘
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
          SSE /api/stream/prices  Portfolio        Trade execution
          (stream.py)             valuation        (POST /api/portfolio/trade,
                                                     LLM-issued trades)
```

Both data sources implement the same `MarketDataSource` ABC (strategy
pattern). Downstream code — SSE streaming, portfolio valuation, trade
execution, watchlist management — never distinguishes which source is
active; it only ever touches the `PriceCache`, plus calls `add_ticker()` /
`remove_ticker()` on whichever `MarketDataSource` instance `factory.py`
constructed. This satisfies PLAN.md §6's requirement that "all downstream
code is agnostic to the source."

---

## 2. File Structure

```
backend/
  app/
    market/
      __init__.py             # Re-exports: PriceUpdate, PriceCache, MarketDataSource,
                               #   create_market_data_source, create_stream_router
      models.py                # PriceUpdate dataclass
      cache.py                 # PriceCache (thread-safe in-memory store)
      interface.py              # MarketDataSource ABC
      seed_prices.py            # SEED_PRICES, TICKER_PARAMS, DEFAULT_PARAMS, CORRELATION_GROUPS
      simulator.py               # GBMSimulator + SimulatorDataSource
      massive_client.py           # MassiveDataSource
      factory.py                   # create_market_data_source()
      stream.py                     # SSE endpoint (FastAPI router factory)
  tests/
    market/
      test_models.py            # PriceUpdate: change/change_percent/direction/to_dict
      test_cache.py              # PriceCache: update/get/get_all/remove/version
      test_simulator.py           # GBMSimulator: GBM math, correlation, add/remove
      test_simulator_source.py     # SimulatorDataSource: lifecycle integration
      test_factory.py               # create_market_data_source(): env-var selection
      test_massive.py                # MassiveDataSource: polling, mocked RESTClient
  market_data_demo.py             # Rich terminal dashboard demo (not part of the app)
```

This is already built and stable — 8 source modules, ~500 lines, 73 tests,
84% coverage. New backend work (`app/db/`, `app/api/`, `app/chat/`) imports
from `app.market` per `backend/CLAUDE.md`; it does not modify these files
except where §11 below calls for a small, additive change to `factory.py`.

---

## 3. Data Model

**File: `backend/app/market/models.py`** (as shipped)

`PriceUpdate` is the only data structure that leaves the market data layer.
Every downstream consumer — SSE streaming, portfolio valuation, trade
execution — works exclusively with this type.

```python
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class PriceUpdate:
    """Immutable snapshot of a single ticker's price at a point in time."""

    ticker: str
    price: float
    previous_price: float
    timestamp: float = field(default_factory=time.time)  # Unix seconds

    @property
    def change(self) -> float:
        """Absolute price change from previous update."""
        return round(self.price - self.previous_price, 4)

    @property
    def change_percent(self) -> float:
        """Percentage change from previous update."""
        if self.previous_price == 0:
            return 0.0
        return round((self.price - self.previous_price) / self.previous_price * 100, 4)

    @property
    def direction(self) -> str:
        """'up', 'down', or 'flat'."""
        if self.price > self.previous_price:
            return "up"
        elif self.price < self.previous_price:
            return "down"
        return "flat"

    def to_dict(self) -> dict:
        """Serialize for JSON / SSE transmission."""
        return {
            "ticker": self.ticker,
            "price": self.price,
            "previous_price": self.previous_price,
            "timestamp": self.timestamp,
            "change": self.change,
            "change_percent": self.change_percent,
            "direction": self.direction,
        }
```

### Design decisions

- **`frozen=True, slots=True`**: immutable, memory-lean value objects — many
  are created per second across 10+ tickers at 2 Hz.
- **Computed properties**: `change`/`change_percent`/`direction` derive from
  `price`/`previous_price` so they can never drift out of sync.
- **`previous_price` is the prior *tick*, not a session reference.** Per
  PLAN.md §6, there is no session-open or prior-close field anywhere in this
  model. The frontend's "change since page load" (§10 of PLAN.md) is computed
  client-side from the first SSE update it sees per ticker — it is not
  derivable from this model and must not be confused with `change_percent`,
  which is only the ~500ms tick-to-tick delta.
- **`to_dict()`** is the single serialization point used by both the SSE
  endpoint (§10 below) and, later, any REST endpoint that embeds a live price
  (e.g. `GET /api/watchlist`'s `price` field, per PLAN.md §8).

---

## 4. Price Cache

**File: `backend/app/market/cache.py`** (as shipped)

The price cache is the central data hub. Data sources write to it; SSE
streaming, portfolio valuation, and trade execution read from it.

```python
from __future__ import annotations

import time
from threading import Lock

from .models import PriceUpdate


class PriceCache:
    """Thread-safe in-memory cache of the latest price for each ticker.

    Writers: SimulatorDataSource or MassiveDataSource (one at a time).
    Readers: SSE streaming endpoint, portfolio valuation, trade execution.
    """

    def __init__(self) -> None:
        self._prices: dict[str, PriceUpdate] = {}
        self._lock = Lock()
        self._version: int = 0  # Monotonically increasing; bumped on every update

    def update(self, ticker: str, price: float, timestamp: float | None = None) -> PriceUpdate:
        """Record a new price for a ticker. Returns the created PriceUpdate.

        Automatically computes direction and change from the previous price.
        If this is the first update for the ticker, previous_price == price (direction='flat').
        """
        with self._lock:
            ts = timestamp or time.time()
            prev = self._prices.get(ticker)
            previous_price = prev.price if prev else price

            update = PriceUpdate(
                ticker=ticker,
                price=round(price, 2),
                previous_price=round(previous_price, 2),
                timestamp=ts,
            )
            self._prices[ticker] = update
            self._version += 1
            return update

    def get(self, ticker: str) -> PriceUpdate | None:
        """Get the latest price for a single ticker, or None if unknown."""
        with self._lock:
            return self._prices.get(ticker)

    def get_all(self) -> dict[str, PriceUpdate]:
        """Snapshot of all current prices. Returns a shallow copy."""
        with self._lock:
            return dict(self._prices)

    def get_price(self, ticker: str) -> float | None:
        """Convenience: get just the price float, or None."""
        update = self.get(ticker)
        return update.price if update else None

    def remove(self, ticker: str) -> None:
        """Remove a ticker from the cache (e.g., when removed from watchlist)."""
        with self._lock:
            self._prices.pop(ticker, None)

    @property
    def version(self) -> int:
        """Current version counter. Useful for SSE change detection."""
        return self._version

    def __len__(self) -> int:
        with self._lock:
            return len(self._prices)

    def __contains__(self, ticker: str) -> bool:
        with self._lock:
            return ticker in self._prices
```

### Why a version counter

The SSE streaming loop polls the cache every ~500ms. Without a version
counter it would re-serialize and resend every price on every tick even when
nothing changed (relevant in Massive mode, where updates only actually land
every 15s). The counter lets the loop skip a send when nothing is new — see
§10.

### `remove()` does not bump `version` — this is intentional, and load-bearing

`remove()` mutates `_prices` but never touches `_version`. Combined with
`stream.py` only emitting on a version change (§10), this means **evicting a
ticker produces no SSE event by itself.** PLAN.md §6 resolves this
explicitly: `DELETE /api/watchlist/{ticker}` and any trade that triggers
`source.remove_ticker()` must drive the removal into the client's local state
directly from that REST call's response, and must treat the SSE stream as an
eventually-consistent secondary signal for this one transition — not the
primary one. Downstream route handlers (§11) must not assume a `remove()`
call will be visible to connected clients on any particular schedule; in the
worst case (every other ticker also stops updating) it may never appear over
SSE at all.

### Thread safety rationale

`threading.Lock`, not `asyncio.Lock`, because:
- `MassiveDataSource._fetch_snapshots()` runs inside `asyncio.to_thread()` —
  a real OS thread, which `asyncio.Lock` does not protect against.
- `threading.Lock` works correctly from both sync threads and the async
  event loop, so one primitive covers both data sources uniformly.

---

## 5. Abstract Interface

**File: `backend/app/market/interface.py`** (as shipped)

```python
from __future__ import annotations

from abc import ABC, abstractmethod


class MarketDataSource(ABC):
    """Contract for market data providers.

    Implementations push price updates into a shared PriceCache on their own
    schedule. Downstream code never calls the data source directly for prices —
    it reads from the cache.

    Lifecycle:
        source = create_market_data_source(cache)
        await source.start(["AAPL", "GOOGL", ...])
        # ... app runs ...
        await source.add_ticker("TSLA")
        await source.remove_ticker("GOOGL")
        # ... app shutting down ...
        await source.stop()
    """

    @abstractmethod
    async def start(self, tickers: list[str]) -> None:
        """Begin producing price updates for the given tickers.

        Starts a background task that periodically writes to the PriceCache.
        Must be called exactly once. Calling start() twice is undefined behavior.
        """

    @abstractmethod
    async def stop(self) -> None:
        """Stop the background task and release resources.

        Safe to call multiple times. After stop(), the source will not write
        to the cache again.
        """

    @abstractmethod
    async def add_ticker(self, ticker: str) -> None:
        """Add a ticker to the active set. No-op if already present.

        The next update cycle will include this ticker.
        """

    @abstractmethod
    async def remove_ticker(self, ticker: str) -> None:
        """Remove a ticker from the active set. No-op if not present.

        Also removes the ticker from the PriceCache.
        """

    @abstractmethod
    def get_tickers(self) -> list[str]:
        """Return the current list of actively tracked tickers."""
```

### Why the source writes to the cache instead of returning prices

This push model decouples timing. The simulator ticks at ~500ms, Massive
polls at 15s (free tier), but SSE always reads from the cache at its own
500ms cadence regardless of which source is active. Neither the SSE layer
nor any REST route needs to know the active source's update interval.

### `remove_ticker()` unconditionally evicts the cache entry too

Both implementations call `self._cache.remove(ticker)` inside
`remove_ticker()`. This is why PLAN.md §6's "keep tracking a held position
after watchlist removal" rule (§11.3 below) requires the watchlist-delete
handler to call `PriceCache` directly and skip `source.remove_ticker()`
entirely when a position is open — there is no variant of `remove_ticker()`
that evicts tracking without also evicting the cache.

---

## 6. Seed Prices & Ticker Parameters

**File: `backend/app/market/seed_prices.py`** (as shipped)

Constants only — no logic, no imports beyond stdlib. Shared by the simulator
for initial prices/GBM parameters.

```python
"""Seed prices and per-ticker parameters for the market simulator."""

# Realistic starting prices for the default watchlist (as of project creation)
SEED_PRICES: dict[str, float] = {
    "AAPL": 190.00,
    "GOOGL": 175.00,
    "MSFT": 420.00,
    "AMZN": 185.00,
    "TSLA": 250.00,
    "NVDA": 800.00,
    "META": 500.00,
    "JPM": 195.00,
    "V": 280.00,
    "NFLX": 600.00,
}

# Per-ticker GBM parameters
# sigma: annualized volatility (higher = more price movement)
# mu: annualized drift / expected return
TICKER_PARAMS: dict[str, dict[str, float]] = {
    "AAPL": {"sigma": 0.22, "mu": 0.05},
    "GOOGL": {"sigma": 0.25, "mu": 0.05},
    "MSFT": {"sigma": 0.20, "mu": 0.05},
    "AMZN": {"sigma": 0.28, "mu": 0.05},
    "TSLA": {"sigma": 0.50, "mu": 0.03},  # High volatility
    "NVDA": {"sigma": 0.40, "mu": 0.08},  # High volatility, strong drift
    "META": {"sigma": 0.30, "mu": 0.05},
    "JPM": {"sigma": 0.18, "mu": 0.04},  # Low volatility (bank)
    "V": {"sigma": 0.17, "mu": 0.04},  # Low volatility (payments)
    "NFLX": {"sigma": 0.35, "mu": 0.05},
}

# Default parameters for tickers not in the list above (dynamically added)
DEFAULT_PARAMS: dict[str, float] = {"sigma": 0.25, "mu": 0.05}

# Correlation groups for the simulator's Cholesky decomposition
# Tickers in the same group have higher intra-group correlation
CORRELATION_GROUPS: dict[str, set[str]] = {
    "tech": {"AAPL", "GOOGL", "MSFT", "AMZN", "META", "NVDA", "NFLX"},
    "finance": {"JPM", "V"},
}

# Correlation coefficients
INTRA_TECH_CORR = 0.6  # Tech stocks move together
INTRA_FINANCE_CORR = 0.5  # Finance stocks move together
CROSS_GROUP_CORR = 0.3  # Between sectors / unknown tickers
TSLA_CORR = 0.3  # TSLA does its own thing
```

Note: an earlier draft of this module had a separate, unused `DEFAULT_CORR`
constant duplicating `CROSS_GROUP_CORR` (flagged in `planning/archive/MARKET_DATA_REVIEW.md`
§4.3). It was removed as part of the review fixes — `CROSS_GROUP_CORR` is now
the single source of truth for the "no special-case correlation" fallback,
used for both cross-sector pairs and tickers outside any known group (e.g. a
symbol a user buys that was never in `SEED_PRICES`/`TICKER_PARAMS`).

---

## 7. GBM Simulator

**File: `backend/app/market/simulator.py`** (as shipped)

Two classes: `GBMSimulator` (pure math engine, stateful) and
`SimulatorDataSource` (the `MarketDataSource` implementation wrapping it in
an async loop).

### 7.1 GBMSimulator — the math engine

```python
"""GBM-based market simulator."""

from __future__ import annotations

import asyncio
import logging
import math
import random

import numpy as np

from .cache import PriceCache
from .interface import MarketDataSource
from .seed_prices import (
    CORRELATION_GROUPS,
    CROSS_GROUP_CORR,
    DEFAULT_PARAMS,
    INTRA_FINANCE_CORR,
    INTRA_TECH_CORR,
    SEED_PRICES,
    TICKER_PARAMS,
    TSLA_CORR,
)

logger = logging.getLogger(__name__)


class GBMSimulator:
    """Geometric Brownian Motion simulator for correlated stock prices.

    Math:
        S(t+dt) = S(t) * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)

    Where:
        S(t)   = current price
        mu     = annualized drift (expected return)
        sigma  = annualized volatility
        dt     = time step as fraction of a trading year
        Z      = correlated standard normal random variable

    The tiny dt (~8.5e-8 for 500ms ticks over 252 trading days * 6.5h/day)
    produces sub-cent moves per tick that accumulate naturally over time.
    """

    # 500ms expressed as a fraction of a trading year
    # 252 trading days * 6.5 hours/day * 3600 seconds/hour = 5,896,800 seconds
    TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600  # 5,896,800
    DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR  # ~8.48e-8

    def __init__(
        self,
        tickers: list[str],
        dt: float = DEFAULT_DT,
        event_probability: float = 0.001,
    ) -> None:
        self._dt = dt
        self._event_prob = event_probability

        # Per-ticker state
        self._tickers: list[str] = []
        self._prices: dict[str, float] = {}
        self._params: dict[str, dict[str, float]] = {}

        # Cholesky decomposition of the correlation matrix (for correlated moves)
        self._cholesky: np.ndarray | None = None

        # Initialize all starting tickers
        for ticker in tickers:
            self._add_ticker_internal(ticker)
        self._rebuild_cholesky()

    # --- Public API ---

    def step(self) -> dict[str, float]:
        """Advance all tickers by one time step. Returns {ticker: new_price}.

        This is the hot path — called every 500ms. Keep it fast.
        """
        n = len(self._tickers)
        if n == 0:
            return {}

        # Generate n independent standard normal draws
        z_independent = np.random.standard_normal(n)

        # Apply Cholesky to get correlated draws
        if self._cholesky is not None:
            z_correlated = self._cholesky @ z_independent
        else:
            z_correlated = z_independent

        result: dict[str, float] = {}
        for i, ticker in enumerate(self._tickers):
            params = self._params[ticker]
            mu = params["mu"]
            sigma = params["sigma"]

            # GBM: S(t+dt) = S(t) * exp((mu - 0.5*sigma^2)*dt + sigma*sqrt(dt)*Z)
            drift = (mu - 0.5 * sigma**2) * self._dt
            diffusion = sigma * math.sqrt(self._dt) * z_correlated[i]
            self._prices[ticker] *= math.exp(drift + diffusion)

            # Random event: ~0.1% chance per tick per ticker
            # With 10 tickers at 2 ticks/sec, expect an event ~every 50 seconds
            if random.random() < self._event_prob:
                shock_magnitude = random.uniform(0.02, 0.05)
                shock_sign = random.choice([-1, 1])
                self._prices[ticker] *= 1 + shock_magnitude * shock_sign
                logger.debug(
                    "Random event on %s: %.1f%% %s",
                    ticker,
                    shock_magnitude * 100,
                    "up" if shock_sign > 0 else "down",
                )

            result[ticker] = round(self._prices[ticker], 2)

        return result

    def add_ticker(self, ticker: str) -> None:
        """Add a ticker to the simulation. Rebuilds the correlation matrix."""
        if ticker in self._prices:
            return
        self._add_ticker_internal(ticker)
        self._rebuild_cholesky()

    def remove_ticker(self, ticker: str) -> None:
        """Remove a ticker from the simulation. Rebuilds the correlation matrix."""
        if ticker not in self._prices:
            return
        self._tickers.remove(ticker)
        del self._prices[ticker]
        del self._params[ticker]
        self._rebuild_cholesky()

    def get_price(self, ticker: str) -> float | None:
        """Current price for a ticker, or None if not tracked."""
        return self._prices.get(ticker)

    def get_tickers(self) -> list[str]:
        """Return the list of currently tracked tickers."""
        return list(self._tickers)

    # --- Internals ---

    def _add_ticker_internal(self, ticker: str) -> None:
        """Add a ticker without rebuilding Cholesky (for batch initialization)."""
        if ticker in self._prices:
            return
        self._tickers.append(ticker)
        self._prices[ticker] = SEED_PRICES.get(ticker, random.uniform(50.0, 300.0))
        self._params[ticker] = TICKER_PARAMS.get(ticker, dict(DEFAULT_PARAMS))

    def _rebuild_cholesky(self) -> None:
        """Rebuild the Cholesky decomposition of the ticker correlation matrix.

        Called whenever tickers are added or removed. O(n^2) but n < 50.
        """
        n = len(self._tickers)
        if n <= 1:
            self._cholesky = None
            return

        # Build the correlation matrix
        corr = np.eye(n)
        for i in range(n):
            for j in range(i + 1, n):
                rho = self._pairwise_correlation(self._tickers[i], self._tickers[j])
                corr[i, j] = rho
                corr[j, i] = rho

        self._cholesky = np.linalg.cholesky(corr)

    @staticmethod
    def _pairwise_correlation(t1: str, t2: str) -> float:
        """Determine correlation between two tickers based on sector grouping.

        Correlation structure:
          - Same tech sector:   0.6
          - Same finance sector: 0.5
          - TSLA with anything: 0.3 (it does its own thing)
          - Cross-sector:       0.3
          - Unknown tickers:    0.3
        """
        tech = CORRELATION_GROUPS["tech"]
        finance = CORRELATION_GROUPS["finance"]

        # TSLA is in tech set but behaves independently
        if t1 == "TSLA" or t2 == "TSLA":
            return TSLA_CORR

        if t1 in tech and t2 in tech:
            return INTRA_TECH_CORR
        if t1 in finance and t2 in finance:
            return INTRA_FINANCE_CORR

        return CROSS_GROUP_CORR
```

### 7.2 SimulatorDataSource — async wrapper

```python
class SimulatorDataSource(MarketDataSource):
    """MarketDataSource backed by the GBM simulator.

    Runs a background asyncio task that calls GBMSimulator.step() every
    `update_interval` seconds and writes results to the PriceCache.
    """

    def __init__(
        self,
        price_cache: PriceCache,
        update_interval: float = 0.5,
        event_probability: float = 0.001,
    ) -> None:
        self._cache = price_cache
        self._interval = update_interval
        self._event_prob = event_probability
        self._sim: GBMSimulator | None = None
        self._task: asyncio.Task | None = None

    async def start(self, tickers: list[str]) -> None:
        self._sim = GBMSimulator(
            tickers=tickers,
            event_probability=self._event_prob,
        )
        # Seed the cache with initial prices so SSE has data immediately
        for ticker in tickers:
            price = self._sim.get_price(ticker)
            if price is not None:
                self._cache.update(ticker=ticker, price=price)
        self._task = asyncio.create_task(self._run_loop(), name="simulator-loop")
        logger.info("Simulator started with %d tickers", len(tickers))

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("Simulator stopped")

    async def add_ticker(self, ticker: str) -> None:
        if self._sim:
            self._sim.add_ticker(ticker)
            # Seed cache immediately so the ticker has a price right away
            price = self._sim.get_price(ticker)
            if price is not None:
                self._cache.update(ticker=ticker, price=price)
            logger.info("Simulator: added ticker %s", ticker)

    async def remove_ticker(self, ticker: str) -> None:
        if self._sim:
            self._sim.remove_ticker(ticker)
        self._cache.remove(ticker)
        logger.info("Simulator: removed ticker %s", ticker)

    def get_tickers(self) -> list[str]:
        return self._sim.get_tickers() if self._sim else []

    async def _run_loop(self) -> None:
        """Core loop: step the simulation, write to cache, sleep."""
        while True:
            try:
                if self._sim:
                    prices = self._sim.step()
                    for ticker, price in prices.items():
                        self._cache.update(ticker=ticker, price=price)
            except Exception:
                logger.exception("Simulator step failed")
            await asyncio.sleep(self._interval)
```

### Key behaviors

- **Immediate seeding**: `start()` and `add_ticker()` both populate the cache
  synchronously before returning, so a newly-added ticker has a price *before*
  the next SSE tick, not just before the next simulator step. This is what
  makes the simulator path effectively immune to `quote_unavailable` (§11.2)
  — the only source that can hit that error path in practice is Massive.
- **`get_tickers()` is public** on `GBMSimulator` (not `_tickers` reached
  from outside) — this was a review fix (`planning/archive/MARKET_DATA_REVIEW.md`
  §3.5) to keep `SimulatorDataSource.get_tickers()` from touching a private
  attribute across the class boundary.
- **Graceful cancellation**: `stop()` cancels the task, awaits it, and
  swallows `CancelledError` — required for clean shutdown inside FastAPI's
  lifespan teardown (§12).
- **Exception resilience**: `_run_loop` catches per-step exceptions so one
  bad tick can't kill the background task.
- **Random events**: ~0.1% chance per tick per ticker of a 2–5% shock. With
  10 tickers at 2 Hz, expect a visible shock roughly every 50 seconds.

---

## 8. Massive API Client

**File: `backend/app/market/massive_client.py`** (as shipped)

Polls the Massive (Polygon.io) REST snapshot endpoint on a configurable
interval. The synchronous `massive` client runs in `asyncio.to_thread()` so
it never blocks the event loop.

```python
"""Massive (Polygon.io) API client for real market data."""

from __future__ import annotations

import asyncio
import logging

from massive import RESTClient
from massive.rest.models import SnapshotMarketType

from .cache import PriceCache
from .interface import MarketDataSource

logger = logging.getLogger(__name__)


class MassiveDataSource(MarketDataSource):
    """MarketDataSource backed by the Massive (Polygon.io) REST API.

    Polls GET /v2/snapshot/locale/us/markets/stocks/tickers for all watched
    tickers in a single API call, then writes results to the PriceCache.

    Rate limits:
      - Free tier: 5 req/min → poll every 15s (default)
      - Paid tiers: higher limits → poll every 2-5s
    """

    def __init__(
        self,
        api_key: str,
        price_cache: PriceCache,
        poll_interval: float = 15.0,
    ) -> None:
        self._api_key = api_key
        self._cache = price_cache
        self._interval = poll_interval
        self._tickers: list[str] = []
        self._task: asyncio.Task | None = None
        self._client: RESTClient | None = None

    async def start(self, tickers: list[str]) -> None:
        self._client = RESTClient(api_key=self._api_key)
        self._tickers = list(tickers)

        # Do an immediate first poll so the cache has data right away
        await self._poll_once()

        self._task = asyncio.create_task(self._poll_loop(), name="massive-poller")
        logger.info(
            "Massive poller started: %d tickers, %.1fs interval",
            len(tickers),
            self._interval,
        )

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._client = None
        logger.info("Massive poller stopped")

    async def add_ticker(self, ticker: str) -> None:
        ticker = ticker.upper().strip()
        if ticker not in self._tickers:
            self._tickers.append(ticker)
            logger.info("Massive: added ticker %s (will appear on next poll)", ticker)

    async def remove_ticker(self, ticker: str) -> None:
        ticker = ticker.upper().strip()
        self._tickers = [t for t in self._tickers if t != ticker]
        self._cache.remove(ticker)
        logger.info("Massive: removed ticker %s", ticker)

    def get_tickers(self) -> list[str]:
        return list(self._tickers)

    # --- Internal ---

    async def _poll_loop(self) -> None:
        """Poll on interval. First poll already happened in start()."""
        while True:
            await asyncio.sleep(self._interval)
            await self._poll_once()

    async def _poll_once(self) -> None:
        """Execute one poll cycle: fetch snapshots, update cache."""
        if not self._tickers or not self._client:
            return

        try:
            # The Massive RESTClient is synchronous — run in a thread to
            # avoid blocking the event loop.
            snapshots = await asyncio.to_thread(self._fetch_snapshots)
            processed = 0
            for snap in snapshots:
                try:
                    price = snap.last_trade.price
                    # Massive timestamps are Unix milliseconds → convert to seconds
                    timestamp = snap.last_trade.timestamp / 1000.0
                    self._cache.update(
                        ticker=snap.ticker,
                        price=price,
                        timestamp=timestamp,
                    )
                    processed += 1
                except (AttributeError, TypeError) as e:
                    logger.warning(
                        "Skipping snapshot for %s: %s",
                        getattr(snap, "ticker", "???"),
                        e,
                    )
            logger.debug("Massive poll: updated %d/%d tickers", processed, len(self._tickers))

        except Exception as e:
            logger.error("Massive poll failed: %s", e)
            # Don't re-raise — the loop will retry on the next interval.
            # Common failures: 401 (bad key), 429 (rate limit), network errors.

    def _fetch_snapshots(self) -> list:
        """Synchronous call to the Massive REST API. Runs in a thread."""
        return self._client.get_snapshot_all(
            market_type=SnapshotMarketType.STOCKS,
            tickers=self._tickers,
        )
```

`massive` is a top-level import (`pyproject.toml` lists `massive>=1.0.0` as a
core dependency, not optional) — an earlier draft lazy-imported it inside
`start()` to keep it optional for simulator-only use, but that made the
`RESTClient` name unpatchable in tests (`planning/archive/MARKET_DATA_REVIEW.md`
§3.2) and was reverted. Students who never set `MASSIVE_API_KEY` still get
`massive` installed via `uv sync`; they just never construct a `RESTClient`.

### Error handling philosophy

| Error | Behavior |
|-------|----------|
| **401 Unauthorized** | Logged as error. Poller keeps running (user might fix `.env` and restart the container). |
| **429 Rate Limited** | Logged as error. Next poll retries after `poll_interval` seconds. |
| **Network timeout** | Logged as error. Retries automatically on next cycle. |
| **Malformed snapshot** | Individual ticker skipped with a warning; other tickers in the same poll still process. |
| **All tickers fail / symbol never quoted** | Cache retains last-known prices (or stays absent for a never-quoted symbol). SSE keeps streaming whatever it has — per PLAN.md §6's "Tradeable Symbols," a ticker Massive never quotes stays permanently in `quote_unavailable` state for trading purposes, which is accepted, not special-cased. |

---

## 9. Factory

**File: `backend/app/market/factory.py`** (as shipped)

```python
"""Factory for creating market data sources."""

from __future__ import annotations

import logging
import os

from .cache import PriceCache
from .interface import MarketDataSource
from .massive_client import MassiveDataSource
from .simulator import SimulatorDataSource

logger = logging.getLogger(__name__)


def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    """Create the appropriate market data source based on environment variables.

    - MASSIVE_API_KEY set and non-empty → MassiveDataSource (real market data)
    - Otherwise → SimulatorDataSource (GBM simulation)

    Returns an unstarted source. Caller must await source.start(tickers).
    """
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()

    if api_key:
        logger.info("Market data source: Massive API (real data)")
        return MassiveDataSource(api_key=api_key, price_cache=price_cache)
    else:
        logger.info("Market data source: GBM Simulator")
        return SimulatorDataSource(price_cache=price_cache)
```

### Required addition: `MARKET_TICK_SECONDS`

PLAN.md §12 ("Determinism & Test Hooks") requires the simulator's ~500ms tick
interval to be overridable via an environment variable so
`test/docker-compose.test.yml` can run E2E scenarios without waiting out
real-time ticks. That variable is not read anywhere yet — this factory is
the correct (and only) place to read it, since it already owns all
env-driven source selection:

```python
def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()

    if api_key:
        logger.info("Market data source: Massive API (real data)")
        return MassiveDataSource(api_key=api_key, price_cache=price_cache)
    else:
        tick_seconds = float(os.environ.get("MARKET_TICK_SECONDS", "0.5"))
        logger.info("Market data source: GBM Simulator (tick=%.3fs)", tick_seconds)
        return SimulatorDataSource(price_cache=price_cache, update_interval=tick_seconds)
```

`SimulatorDataSource.__init__` already accepts `update_interval` (§7.2) — this
is a one-line change to plumb the env var through, not a new capability.
`MASSIVE_API_KEY` deliberately continues to take priority: per PLAN.md §5,
Massive mode is selected purely by key presence, and `MARKET_TICK_SECONDS`
has no meaningful analogue for the Massive poller (its interval is governed
by API rate limits, not test-speed tuning — E2E scenarios use the simulator
via `LLM_MOCK=true` and an unset `MASSIVE_API_KEY`, so this branch is not
exercised in the test compose file).

### Usage at app startup

```python
price_cache = PriceCache()
source = create_market_data_source(price_cache)
await source.start(initial_tickers)  # union of watchlist + held tickers — see §11.1
```

---

## 10. SSE Streaming Endpoint

**File: `backend/app/market/stream.py`** (as shipped)

```python
"""SSE streaming endpoint for live price updates."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .cache import PriceCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stream", tags=["streaming"])


def create_stream_router(price_cache: PriceCache) -> APIRouter:
    """Create the SSE streaming router with a reference to the price cache.

    This factory pattern lets us inject the PriceCache without globals.
    """

    @router.get("/prices")
    async def stream_prices(request: Request) -> StreamingResponse:
        """SSE endpoint for live price updates.

        Streams all tracked ticker prices every ~500ms. The client connects
        with EventSource and receives events in the format:

            data: {"AAPL": {"ticker": "AAPL", "price": 190.50, ...}, ...}

        Includes a retry directive so the browser auto-reconnects on
        disconnection (EventSource built-in behavior).
        """
        return StreamingResponse(
            _generate_events(price_cache, request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # Disable nginx buffering if proxied
            },
        )

    return router


async def _generate_events(
    price_cache: PriceCache,
    request: Request,
    interval: float = 0.5,
) -> AsyncGenerator[str, None]:
    """Async generator that yields SSE-formatted price events.

    Sends all prices every `interval` seconds. Stops when the client
    disconnects (detected via request.is_disconnected()).
    """
    # Tell the client to retry after 1 second if the connection drops
    yield "retry: 1000\n\n"

    last_version = -1
    client_ip = request.client.host if request.client else "unknown"
    logger.info("SSE client connected: %s", client_ip)

    try:
        while True:
            # Check for client disconnect
            if await request.is_disconnected():
                logger.info("SSE client disconnected: %s", client_ip)
                break

            current_version = price_cache.version
            if current_version != last_version:
                last_version = current_version
                prices = price_cache.get_all()

                if prices:
                    data = {ticker: update.to_dict() for ticker, update in prices.items()}
                    payload = json.dumps(data)
                    yield f"data: {payload}\n\n"

            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("SSE stream cancelled for: %s", client_ip)
```

### Wire format (matches PLAN.md §6 verbatim)

```
retry: 1000

data: {"AAPL":{"ticker":"AAPL","price":190.50,"previous_price":190.42,"timestamp":1707580800.5,"change":0.08,"change_percent":0.042,"direction":"up"},"GOOGL":{...}}

```

- One batched event per tick containing **every tracked ticker**, keyed by
  symbol — never a diff, never one-event-per-ticker.
- No `event:` name or `id:` field — every event is the default `message`
  type.
- An event is only emitted when `price_cache.version` has changed since the
  last check, i.e. on any ticker's update, not necessarily "this" ticker's.

Client-side:

```javascript
const eventSource = new EventSource('/api/stream/prices');
eventSource.onmessage = (event) => {
    const prices = JSON.parse(event.data);
    // Replace the local price map wholesale — do not merge deltas.
    // prices is { "AAPL": { ticker, price, previous_price, ... }, ... }
};
```

### Why poll-and-push instead of event-driven

Fixed-interval polling of the cache (rather than the data source notifying
the stream directly) keeps the SSE layer decoupled from either source's
timing and produces evenly-spaced updates, which matters for the frontend's
sparkline accumulation (PLAN.md §10).

---

## 11. Integration Contract for Downstream Routes

This section does not describe existing code — `app/db/`, `app/api/`, and
`app/chat/` do not exist yet. It specifies exactly how those modules, once
built, must call into the market-data module above to satisfy PLAN.md §6
("Market Data") and §8 ("API Endpoints"). Every rule below traces to an
already-resolved section of `planning/PLAN.md`; nothing here is a new design
decision, only its translation into call sequences against the concrete API
in §§3–10.

### 11.1 Ticker Tracking Set — startup reconciliation

PLAN.md §6 defines the tracking set as the union of `watchlist` rows and
`positions` rows with `quantity > 0`, and requires this union to hold **from
the very first `source.start()` call**, not just steady-state. A DB module
providing `load_tracking_set()` and lifespan startup wire this as:

```python
# app/db/tickers.py (illustrative — not yet built)
async def load_tracking_set(conn) -> list[str]:
    """Union of watchlist tickers and tickers with an open position."""
    watchlist_rows = await conn.execute("SELECT ticker FROM watchlist WHERE user_id = ?", ("default",))
    position_rows = await conn.execute(
        "SELECT ticker FROM positions WHERE user_id = ? AND quantity > 0", ("default",)
    )
    tickers = {row["ticker"] for row in await watchlist_rows.fetchall()}
    tickers |= {row["ticker"] for row in await position_rows.fetchall()}
    return sorted(tickers)
```

```python
# app/main.py lifespan (illustrative)
initial_tickers = await load_tracking_set(db_conn)  # NOT watchlist alone
await source.start(initial_tickers)
```

Without this, a position held from a ticker whose watchlist entry was
removed while the position stayed open (§11.3) would silently stop receiving
quotes across a container restart, even though the position is still open —
this is PLAN.md §6's explicit warning and Codex review finding H1.

### 11.2 Tradeable Symbols — `quote_unavailable`

Any syntactically valid ticker is tradeable, watchlisted or not (PLAN.md §6
"Tradeable Symbols"). A trade handler must:

```python
# app/api/portfolio.py (illustrative)
@router.post("/portfolio/trade")
async def execute_trade(body: TradeRequest, cache: PriceCache = Depends(get_price_cache),
                         source: MarketDataSource = Depends(get_market_source)):
    ticker = normalize_ticker(body.ticker)  # upper+strip; reject invalid_ticker per §8

    price = cache.get_price(ticker)
    if price is None:
        # Idempotent — safe even if the ticker is already tracked by coincidence
        # (e.g. re-buying a ticker whose position was just fully closed & unsubscribed).
        await source.add_ticker(ticker)
        raise QuoteUnavailableError(ticker)  # -> 409 quote_unavailable, per §8's error table

    # ... proceed with the BEGIN IMMEDIATE trade transaction (PLAN.md §7) using `price` ...
```

`quote_unavailable` (409) is distinct from `not_watchlisted`/`no_position`
(404): the latter is "this row doesn't exist in the DB," the former is "this
ticker exists (or was just newly tracked) but has no price yet." Neither
implies the other. In the simulator, `add_ticker()` seeds the cache
synchronously (§7.2) so this branch is effectively unreachable for the
simulator path; in Massive mode it is a real race, up to the poll interval
(worst case 15s on the free tier).

### 11.3 Watchlist add / remove

**Add** (`POST /api/watchlist`):

```python
@router.post("/watchlist")
async def add_to_watchlist(body: WatchlistAdd, source=Depends(get_market_source),
                            cache: PriceCache = Depends(get_price_cache)):
    ticker = normalize_ticker(body.ticker)
    if await db.watchlist_row_exists(ticker):
        raise DuplicateTickerError(ticker)  # 409

    if ticker not in source.get_tickers():
        await source.add_ticker(ticker)  # no-op if already tracked via an open position

    await db.insert_watchlist_row(ticker)
    return {"ticker": ticker, "added_at": now_rfc3339(), "price": cache.get_price(ticker)}
```

**Remove** (`DELETE /api/watchlist/{ticker}`) — the one-way rule from PLAN.md
§6 that this whole module's `remove_ticker()` cannot express on its own
(§5's "unconditionally evicts the cache" note):

```python
@router.delete("/watchlist/{ticker}", status_code=204)
async def remove_from_watchlist(ticker: str, source=Depends(get_market_source),
                                 cache: PriceCache = Depends(get_price_cache)):
    ticker = normalize_ticker(ticker)
    if not await db.watchlist_row_exists(ticker):
        raise NotWatchlistedError(ticker)  # 404

    await db.delete_watchlist_row(ticker)

    position = await db.get_open_position(ticker)
    if position is None:
        await source.remove_ticker(ticker)   # evicts tracking AND the cache entry
    # else: leave tracking and the cache entry alone — the position needs live
    # valuation even though it's no longer watchlisted. Do NOT call
    # cache.remove() here either; only remove_ticker() closes this out (§11.4).
```

### 11.4 Trade that zeroes a position — the other half of §11.3

When a sell brings `positions.quantity` to exactly `0` (after the §7
rounding-to-6-decimals rule) and the row is deleted, the same trade handler
must check watchlist membership and unsubscribe if appropriate — this is the
step that actually stops tracking a closed, unwatchlisted position, since
§11.3's removal path only fires while the position is still open:

```python
# continuing the trade handler from §11.2, inside the same BEGIN IMMEDIATE transaction's
# post-commit follow-up
if new_quantity_after_sell == 0:
    await db.delete_position_row(ticker)
    if not await db.watchlist_row_exists(ticker):
        await source.remove_ticker(ticker)
```

Without this step (Codex review finding, resolved in PLAN.md §6), a closed
position that was never watchlisted — or was unwatchlisted while open, per
§11.3 — would be tracked (and, in Massive mode, polled) forever.

### 11.5 Rules NOT to reimplement

Everything above composes calls already provided by §§3–10; no downstream
module should:
- Reach into `GBMSimulator` or `MassiveDataSource` internals directly —
  always go through the `MarketDataSource` interface (§5) so route code
  stays source-agnostic, matching §1's architecture goal.
- Call `PriceCache.remove()` directly except in the one documented exception
  in §11.3 (open-position watchlist removal). Every other eviction path goes
  through `source.remove_ticker()`, which already calls it.
- Poll for a price after calling `add_ticker()` before responding to the
  client. §11.2 already covers the "no quote yet" case with `quote_unavailable`;
  blocking the request would contradict PLAN.md §6's explicit "reject
  immediately rather than blocking" instruction.

---

## 12. FastAPI Lifecycle Integration

The market data system starts and stops with the FastAPI app via `lifespan`,
after database initialization (PLAN.md §7 requires DB init to complete
before market-data or snapshot background tasks start, since both read
`watchlist`/`positions`).

```python
# app/main.py (illustrative — main.py does not exist yet)
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.market import PriceCache, create_market_data_source, create_stream_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- STARTUP ---
    await init_db()  # PLAN.md §7: schema + seed, before anything reads watchlist/positions

    price_cache = PriceCache()
    app.state.price_cache = price_cache

    source = create_market_data_source(price_cache)
    app.state.market_source = source

    initial_tickers = await load_tracking_set(db_conn)  # §11.1 — union, not watchlist alone
    await source.start(initial_tickers)

    app.include_router(create_stream_router(price_cache))

    yield  # App is running

    # --- SHUTDOWN ---
    await source.stop()


app = FastAPI(title="FinAlly", lifespan=lifespan)


def get_price_cache() -> PriceCache:
    return app.state.price_cache


def get_market_source() -> MarketDataSource:
    return app.state.market_source
```

Per PLAN.md §11, this runs as a single Uvicorn worker (no `--workers`,
required by §7's "Transactions & Concurrency" in-process lock). The `/api/*`
and `/api/stream/*` routers register before the static-file catch-all so an
unmatched `/api/...` path always 404s in the §8 JSON envelope rather than
falling through to `index.html`.

---

## 13. Testing Strategy

### As shipped (`backend/tests/market/`, 73 tests, 84% coverage)

| Module | Tests | Coverage | Notes |
|--------|-------|----------|-------|
| `test_models.py` | 11 | 100% | `change`/`change_percent`/`direction`/`to_dict` |
| `test_cache.py` | 13 | 100% | update/get/get_all/remove/version incl. `remove()` not bumping version |
| `test_simulator.py` | 17 | 98% | GBM math, correlation matrix, add/remove, positivity |
| `test_simulator_source.py` | 10 | (integration) | lifecycle: start/stop/add/remove against a real asyncio loop |
| `test_factory.py` | 7 | 100% | env-var-driven source selection |
| `test_massive.py` | 13 | 56% (expected) | mocked `RESTClient`/snapshots; real API surface untestable without a key |

`stream.py` has no dedicated unit tests today (SSE requires an ASGI test
client to exercise meaningfully) — see recommended addition below.

### Determinism hook required by PLAN.md §12

> "GBM math is correct (using an injectable/seeded RNG — the simulator must
> accept an optional seed or generator so a test can assert exact output, not
> just statistical properties)."

`GBMSimulator` currently draws from module-level `np.random.standard_normal`
and `random.random()`/`random.uniform()`/`random.choice()` with no seed hook
— today's tests assert statistical properties (positivity, ticker set
membership) rather than exact values. Closing this gap means threading a
`numpy.random.Generator` (and a seeded `random.Random` for the event/shock
draws) through `GBMSimulator.__init__`, defaulting to global state when
omitted so production behavior is unchanged:

```python
def __init__(
    self,
    tickers: list[str],
    dt: float = DEFAULT_DT,
    event_probability: float = 0.001,
    rng: np.random.Generator | None = None,
) -> None:
    self._rng = rng or np.random.default_rng()
    ...
    z_independent = self._rng.standard_normal(n)  # replaces np.random.standard_normal(n)
```

A test can then assert exact output:

```python
def test_deterministic_step_with_seed():
    rng = np.random.default_rng(seed=42)
    sim = GBMSimulator(tickers=["AAPL"], rng=rng)
    result = sim.step()
    assert result["AAPL"] == pytest.approx(190.0 * expected_factor, abs=1e-2)
```

### Recommended additions (not yet written)

- **SSE integration test** using `httpx.AsyncClient(app=app)` against a
  running FastAPI instance: assert the `retry: 1000` preamble, one JSON
  object per event keyed by ticker, and that events stop being distinguishable
  when `price_cache.version` doesn't change between polls.
- **`PriceCache` concurrent-writer test**: spin up several threads calling
  `update()` simultaneously and assert no lost updates / no corrupted
  `version` count — the lock usage looks correct by inspection but has no
  empirical test today.
- **Full 10-ticker Cholesky test**: today's simulator tests use 1–2 tickers;
  add one asserting the correlation matrix for the entire default watchlist
  is valid (positive semi-definite) and `np.linalg.cholesky` doesn't raise.
- **`quote_unavailable` race test** (once §11 lands): a trade issued
  immediately after `POST /api/watchlist` for a ticker with `MASSIVE_API_KEY`
  set should 409 before the first poll completes.

---

## 14. Configuration Summary

| Parameter | Location | Default | Description |
|-----------|----------|---------|-------------|
| `MASSIVE_API_KEY` | Environment variable | `""` (empty) | If set, use Massive API; otherwise use simulator (§9) |
| `MARKET_TICK_SECONDS` | Environment variable, read in `factory.py` (§9, not yet wired) | `0.5` | Simulator tick interval; overridden to sub-second in `test/docker-compose.test.yml` per PLAN.md §12 |
| `update_interval` | `SimulatorDataSource.__init__` | `0.5` (seconds) | Time between simulator ticks — set from `MARKET_TICK_SECONDS` once §9's change lands |
| `poll_interval` | `MassiveDataSource.__init__` | `15.0` (seconds) | Time between Massive API polls (free-tier default; PLAN.md doesn't mandate a paid-tier env override) |
| `event_probability` | `GBMSimulator.__init__` | `0.001` | Chance of a random shock event per ticker per tick |
| `dt` | `GBMSimulator.__init__` | `~8.5e-8` | GBM time step (fraction of a trading year) |
| SSE push interval | `_generate_events()` | `0.5` (seconds) | Time between cache polls inside the SSE generator |
| SSE retry directive | `_generate_events()` | `1000` (ms) | Browser `EventSource` reconnection delay |

### Package `__init__.py` (as shipped)

```python
"""Market data subsystem for FinAlly.

Public API:
    PriceUpdate         - Immutable price snapshot dataclass
    PriceCache          - Thread-safe in-memory price store
    MarketDataSource    - Abstract interface for data providers
    create_market_data_source - Factory that selects simulator or Massive
    create_stream_router - FastAPI router factory for SSE endpoint
"""

from .cache import PriceCache
from .factory import create_market_data_source
from .interface import MarketDataSource
from .models import PriceUpdate
from .stream import create_stream_router

__all__ = [
    "PriceUpdate",
    "PriceCache",
    "MarketDataSource",
    "create_market_data_source",
    "create_stream_router",
]
```
