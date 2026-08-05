# Backend — Developer Guide

## Project Setup

```bash
cd backend
uv sync --extra dev   # Install all dependencies including test/lint tools
uv run uvicorn app.main:app --reload --port 8000
```

The project-root `.env` is loaded automatically by `app/config.py` (real
environment variables always win, so Docker's `--env-file` is unaffected).

## Application Layout

```
app/
├── main.py          FastAPI app factory + lifespan (DB init → market source → snapshot task)
├── config.py        All env vars, read per call so tests can monkeypatch
├── errors.py        ApiError + the handlers producing the §8 error envelope
├── state.py         Process-wide singletons: price_cache, market_source
├── utils.py         Ticker normalization, RFC 3339 timestamps, rounding rules
├── db/              schema.sql, connection/transaction helpers, startup init + seed
├── api/             Routers: health, portfolio, watchlist, chat
├── services/        Shared business logic (see below)
└── market/          Market data subsystem (see "Market Data API")
```

`uvicorn app.main:app` is the entry point; run it single-process (no `--workers`),
which PLAN.md §7's concurrency model requires.

## Services

`app/services/` holds the logic shared by the REST routers and the LLM chat flow.
Call these rather than re-implementing trade or watchlist rules:

```python
from app.services.portfolio import execute_trade, get_portfolio
from app.services.watchlist import add_ticker, get_watchlist, remove_ticker
from app.services.snapshots import list_snapshots, record_snapshot
from app.services.tracking import tracked_tickers
```

- **`execute_trade(ticker, quantity, side) -> TradeResult`** (async) — the single
  path for every market order. Normalizes the ticker, validates, runs one
  `BEGIN IMMEDIATE` transaction under the process-wide write lock, records the
  post-trade snapshot, and maintains the §6 ticker tracking set. Raises
  `ApiError` on any validation failure.
- **`add_ticker` / `remove_ticker`** (async) — watchlist mutations that also
  subscribe/unsubscribe the market data source, honoring the rule that a held
  position keeps a ticker tracked even once un-watchlisted.

These acquire the write lock internally — do not hold it around them, or you will
deadlock.

## Database

```python
from app.db import init_db, read_connection, transaction, write_lock
```

`transaction()` wraps `BEGIN IMMEDIATE` / `COMMIT` with rollback on error.
`write_lock()` is the single `asyncio.Lock` serializing portfolio writes. Schema
lives in `app/db/schema.sql` and is created and seeded during startup.

Note: the schema file lives under `app/db/`, not the `backend/db/` path sketched
in PLAN.md §4 — `backend/` is copied to `/app` in the image, so `backend/db/`
would be shadowed by the runtime bind mount at `/app/db` (§11).

## Errors

Raise `ApiError("<code>")` anywhere in a request path; `ERROR_CATALOG` in
`app/errors.py` supplies the status and default message. Every non-2xx response —
including FastAPI's own validation failures and unhandled exceptions — is
normalized to `{"error": {"code", "message"}}`.

## Market Data API

The market data subsystem lives in `app/market/`. Use these imports:

```python
from app.market import PriceCache, PriceUpdate, MarketDataSource, create_market_data_source
```

### Core Types

- **`PriceUpdate`** — Immutable dataclass: `ticker`, `price`, `previous_price`, `timestamp`, plus properties `change`, `change_percent`, `direction` ("up"/"down"/"flat"), and `to_dict()` for JSON serialization.

- **`PriceCache`** — Thread-safe in-memory store. Key methods:
  - `update(ticker, price, timestamp=None) -> PriceUpdate`
  - `get(ticker) -> PriceUpdate | None`
  - `get_price(ticker) -> float | None`
  - `get_all() -> dict[str, PriceUpdate]`
  - `remove(ticker)`
  - `version` property — monotonic counter, increments on every update (for SSE change detection)

- **`MarketDataSource`** — Abstract interface implemented by `SimulatorDataSource` and `MassiveDataSource`. Lifecycle: `start(tickers)` -> `add_ticker()` / `remove_ticker()` -> `stop()`.

- **`create_market_data_source(cache)`** — Factory. Returns `MassiveDataSource` if `MASSIVE_API_KEY` is set, otherwise `SimulatorDataSource`.

### SSE Streaming

```python
from app.market import create_stream_router

# interval must track MARKET_TICK_SECONDS — the emit rate is the slower of the
# producer tick and this poll interval.
router = create_stream_router(price_cache, interval=config.market_tick_seconds())
# Endpoint: GET /api/stream/prices (text/event-stream)
```

### Seed Data

Default tickers: AAPL, GOOGL, MSFT, AMZN, TSLA, NVDA, META, JPM, V, NFLX. Seed prices and per-ticker volatility/drift params are in `app/market/seed_prices.py`.

## Running Tests

```bash
uv run --extra dev pytest -v              # All tests
uv run --extra dev pytest --cov=app       # With coverage
uv run --extra dev ruff check app/ tests/ # Lint
```

## Demo

```bash
uv run market_data_demo.py   # Live terminal dashboard with simulated prices
```
