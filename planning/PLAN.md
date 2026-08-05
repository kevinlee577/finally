# FinAlly — AI Trading Workstation

## Project Specification

## 1. Vision

FinAlly (Finance Ally) is a visually stunning AI-powered trading workstation that streams live market data, lets users trade a simulated portfolio, and integrates an LLM chat assistant that can analyze positions and execute trades on the user's behalf. It looks and feels like a modern Bloomberg terminal with an AI copilot.

This is the capstone project for an agentic AI coding course. It is built entirely by Coding Agents demonstrating how orchestrated AI agents can produce a production-quality full-stack application. Agents interact through files in `planning/`.

## 2. User Experience

### First Launch

The user runs a single Docker command (or a provided start script). A browser opens to `http://localhost:8000`. No login, no signup. They immediately see:

- A watchlist of 10 default tickers with live-updating prices in a grid
- $10,000 in virtual cash
- A dark, data-rich trading terminal aesthetic
- An AI chat panel ready to assist

### What the User Can Do

- **Watch prices stream** — prices flash green (uptick) or red (downtick) with subtle CSS animations that fade
- **View sparkline mini-charts** — price action beside each ticker in the watchlist, accumulated on the frontend from the SSE stream since page load (sparklines fill in progressively)
- **Click a ticker** to see a larger detailed chart in the main chart area
- **Buy and sell shares** — market orders only, instant fill at current price, no fees, no confirmation dialog
- **Monitor their portfolio** — a heatmap (treemap) showing positions sized by weight and colored by P&L, plus a P&L chart tracking total portfolio value over time
- **View a positions table** — ticker, quantity, average cost, current price, unrealized P&L, % change
- **Chat with the AI assistant** — ask about their portfolio, get analysis, and have the AI execute trades and manage the watchlist through natural language
- **Manage the watchlist** — add/remove tickers manually or via the AI chat

### Visual Design

- **Dark theme**: backgrounds around `#0d1117` or `#1a1a2e`, muted gray borders, no pure black
- **Price flash animations**: brief green/red background highlight on price change, fading over ~500ms via CSS transitions
- **Connection status indicator**: a small colored dot (green = connected, yellow = reconnecting, red = disconnected) visible in the header
- **Professional, data-dense layout**: inspired by Bloomberg/trading terminals — every pixel earns its place
- **Responsive but desktop-first**: optimized for wide screens, functional on tablet

### Color Scheme
- Accent Yellow: `#ecad0a`
- Blue Primary: `#209dd7`
- Purple Secondary: `#753991` (submit buttons)

## 3. Architecture Overview

### Single Container, Single Port

```
┌─────────────────────────────────────────────────┐
│  Docker Container (port 8000)                   │
│                                                 │
│  FastAPI (Python/uv)                            │
│  ├── /api/*          REST endpoints             │
│  ├── /api/stream/*   SSE streaming              │
│  └── /*              Static file serving         │
│                      (Next.js export)            │
│                                                 │
│  SQLite database (volume-mounted)               │
│  Background task: market data polling/sim        │
└─────────────────────────────────────────────────┘
```

- **Frontend**: Next.js with TypeScript, built as a static export (`output: 'export'`), served by FastAPI as static files
- **Backend**: FastAPI (Python), managed as a `uv` project
- **Database**: SQLite, single file at `db/finally.db`, volume-mounted for persistence
- **Real-time data**: Server-Sent Events (SSE) — simpler than WebSockets, one-way server→client push, works everywhere
- **AI integration**: LiteLLM → OpenRouter (Cerebras for fast inference), with structured outputs for trade execution
- **Market data**: Environment-variable driven — simulator by default, real data via Massive API if key provided

### Why These Choices

| Decision | Rationale |
|---|---|
| SSE over WebSockets | One-way push is all we need; simpler, no bidirectional complexity, universal browser support |
| Static Next.js export | Single origin, no CORS issues, one port, one container, simple deployment |
| SQLite over Postgres | No auth = no multi-user = no need for a database server; self-contained, zero config |
| Single Docker container | Students run one command; no docker-compose for production, no service orchestration |
| uv for Python | Fast, modern Python project management; reproducible lockfile; what students should learn |
| Market orders only | Eliminates order book, limit order logic, partial fills — dramatically simpler portfolio math |

---

## 4. Directory Structure

This is the **target** layout, not the current repo state. As of this writing only `backend/app/market/` (the market-data module) and `planning/` exist; `frontend/`, `backend/db/`, `db/`, `test/`, `scripts/`, `Dockerfile`, and `.env.example` are still to be created by the agents that own them.

```
finally/
├── frontend/                 # Next.js TypeScript project (static export)
├── backend/                  # FastAPI uv project (Python)
│   └── app/db/               # Schema definitions, seed data, migration logic
├── planning/                 # Project-wide documentation for agents
│   ├── PLAN.md               # This document
│   └── ...                   # Additional agent reference docs
├── scripts/
│   ├── start_mac.sh          # Launch Docker container (macOS/Linux)
│   ├── stop_mac.sh           # Stop Docker container (macOS/Linux)
│   ├── start_windows.ps1     # Launch Docker container (Windows PowerShell)
│   └── stop_windows.ps1      # Stop Docker container (Windows PowerShell)
├── test/                     # Playwright E2E tests + docker-compose.test.yml
├── db/                       # Volume mount target (SQLite file lives here at runtime)
│   └── .gitkeep              # Keeps the directory in git; finally.db and its -wal/-shm/-journal sidecars are gitignored (see §7)
├── Dockerfile                # Multi-stage build (Node → Python)
├── .env                      # Environment variables (gitignored, .env.example committed)
└── .gitignore
```

### Key Boundaries

- **`frontend/`** is a self-contained Next.js project. It knows nothing about Python. It talks to the backend via `/api/*` endpoints and `/api/stream/*` SSE endpoints. Internal structure is up to the Frontend Engineer agent.
- **`backend/`** is a self-contained uv project with its own `pyproject.toml`. It owns all server logic including database initialization, schema, seed data, API routes, SSE streaming, market data, and LLM integration. Internal structure is up to the Backend/Market Data agents.
- **`backend/app/db/`** contains schema SQL definitions and seed logic. It lives inside the `app` package rather than at `backend/db/` deliberately: §11's Dockerfile copies `backend/` into the image, and §11's `docker run` then bind-mounts the top-level `db/` directory over `/app/db` at container start — a `backend/db/` directory containing the schema would be shadowed by that runtime mount and vanish. Keeping schema/seed code inside `backend/app/` avoids the collision. The backend initializes the database during FastAPI startup (see §7) — creating tables and seeding default data if the SQLite file doesn't exist or is empty.
- **`db/`** at the top level is the runtime volume mount point. The SQLite file (`db/finally.db`) is created here by the backend and persists across container restarts via Docker volume.
- **`planning/`** contains project-wide documentation, including this plan. All agents reference files here as the shared contract.
- **`test/`** contains Playwright E2E tests and supporting infrastructure (e.g., `docker-compose.test.yml`). Unit tests live within `frontend/` and `backend/` respectively, following each framework's conventions.
- **`scripts/`** contains start/stop scripts that wrap Docker commands.

---

## 5. Environment Variables

```bash
# Required: OpenRouter API key for LLM chat functionality
OPENROUTER_API_KEY=your-openrouter-api-key-here

# Optional: Massive (Polygon.io) API key for real market data
# If not set, the built-in market simulator is used (recommended for most users)
MASSIVE_API_KEY=

# Optional: Set to "true" for deterministic mock LLM responses (testing)
LLM_MOCK=false
```

### Behavior

- If `MASSIVE_API_KEY` is set and non-empty → backend uses Massive REST API for market data
- If `MASSIVE_API_KEY` is absent or empty → backend uses the built-in market simulator
- If `LLM_MOCK=true` → backend returns deterministic mock LLM responses (for E2E tests)
- If `OPENROUTER_API_KEY` is absent or empty and `LLM_MOCK` is not `"true"` → the backend still starts and serves prices, portfolio, and watchlist normally (§2's first-launch promise holds for everything except chat). `POST /api/chat` returns `503` with `{"error": {"code": "chat_unavailable", "message": "AI chat is not configured — set OPENROUTER_API_KEY to enable it."}}` instead of calling the LLM, and the chat panel UI renders a disabled state with that message rather than a generic error. The app does **not** fail to start over a missing chat key — only chat itself degrades.
- The backend reads `.env` from the project root (mounted into the container or read via docker `--env-file`)
- Three additional environment variables exist for deployment/testing and are intentionally omitted from `.env.example` (they have sensible production defaults and aren't secrets): `DB_PATH` (§11, default `/app/db/finally.db`), `MARKET_TICK_SECONDS` and `SNAPSHOT_INTERVAL_SECONDS` (§12, defaulting to the production ~500ms/30s values). `test/docker-compose.test.yml` overrides all three for fast, isolated E2E runs.

---

## 6. Market Data

### Two Implementations, One Interface

Both the simulator and the Massive client implement the same abstract interface. The backend selects which to use based on the environment variable. All downstream code (SSE streaming, price cache, frontend) is agnostic to the source.

### Simulator (Default)

- Generates prices using geometric Brownian motion (GBM) with configurable drift and volatility per ticker
- Updates at ~500ms intervals
- Correlated moves across tickers (e.g., tech stocks move together)
- Occasional random "events" — sudden 2-5% moves on a ticker for drama
- Starts from realistic seed prices (e.g., AAPL ~$190, GOOGL ~$175, etc.)
- Runs as an in-process background task — no external dependencies

### Massive API (Optional)

- REST API polling (not WebSocket) — simpler, works on all tiers
- Polls for the union of watchlisted and held tickers (see "Ticker Tracking Set" below) on a configurable interval
- Free tier (5 calls/min): poll every 15 seconds
- Paid tiers: poll every 2-15 seconds depending on tier
- Parses REST response into the same format as the simulator

### Shared Price Cache

- A single background task (simulator or Massive poller) writes to an in-memory price cache
- The cache holds the latest price, previous price, and timestamp for each ticker
- SSE streams read from this cache and push updates to connected clients
- This architecture supports future multi-user scenarios without changes to the data layer

### Ticker Tracking Set

The set of tickers a `MarketDataSource` actively tracks (and therefore appears in the price cache and SSE stream) is always the union of two things: the current `watchlist` table rows and any `positions` row with `quantity > 0`. This union must hold at every point in the app's lifecycle, not just while it's running:

- **On startup**, `source.start(tickers)` is called with this union computed fresh from the database — not from the watchlist alone. Without this, a ticker held from a position closed's prior watchlist removal (§6 "Held positions..." below) would silently stop receiving quotes across a container restart, even though the position is still open.
- **On ticker addition** (`POST /api/watchlist`): the handler normalizes the ticker (§8), and if it is not already in the tracking set (no existing watchlist row and no open position), calls `source.add_ticker(ticker)` before inserting the `watchlist` row. `add_ticker()` is a no-op if the ticker is already tracked (per `interface.py`), so re-adding a ticker whose position kept it tracked after a prior removal is safe either way.
- **On trade for a ticker not yet in the tracking set**: a manual or LLM-issued buy for a symbol with no watchlist row and no existing position is allowed (see "Tradeable Symbols" below) and must call `source.add_ticker(ticker)` as part of the same trade so the position becomes trackable going forward — the trade itself still requires a cached quote to fill (see below), so this only matters for symbols already tracked by coincidence (e.g. re-buying a ticker whose position was just fully closed and unsubscribed).
- **On watchlist removal and position close**: unchanged from the rules below — removal only evicts the tracking set/cache when no position is open, and a trade that zeroes a position only unsubscribes it when it is not (or no longer) watchlisted.

### Tradeable Symbols

A trade (`POST /api/portfolio/trade`, or an LLM-issued trade) is permitted for **any syntactically valid ticker** (normalized per §8), not just symbols already on the watchlist — a user can buy a ticker they've never watchlisted. However, a trade always requires a quote:

- If the ticker has no entry in the `PriceCache` yet, the handler first calls `source.add_ticker(ticker)` (idempotent — safe even if already tracked) and rejects the trade immediately with `quote_unavailable` (§8) rather than blocking until a quote appears. The client can retry after the next SSE tick shows a price for that ticker (simulator: ~500ms; Massive: up to the poll interval, up to 15s on the free tier — Massive may also simply never return a quote for an invalid/delisted symbol, in which case the ticker stays permanently in `quote_unavailable` state, which is an acceptable outcome for this app, not an error to special-case further).
- This means `not_watchlisted`/`no_position` (§8) and `quote_unavailable` (§8) are distinct failure modes: `not_watchlisted`/`no_position` are for an operation on something that doesn't exist in the DB (`DELETE /api/watchlist/{ticker}` on a ticker not on the list, or a sell for a ticker with no open position). `quote_unavailable` is for a trade on a ticker that exists (or was just newly tracked) but has no price yet. Neither implies the other.

### SSE Streaming

- Endpoint: `GET /api/stream/prices`
- Long-lived SSE connection; client uses native `EventSource` API
- On connect, the server sends a `retry: 1000` directive once. After that, roughly every 500ms it checks the shared `PriceCache` version counter; whenever it has changed since the last tick (i.e. at least one tracked ticker updated), it emits a single event — there is no `event:`/`id:` field, so every event is the default `message` type. The event's `data:` line is a JSON object keyed by ticker symbol, containing the **full current snapshot of every tracked ticker** (not a diff and not one-event-per-ticker):

  ```
  data: {"AAPL": {"ticker": "AAPL", "price": 190.50, "previous_price": 190.30, "timestamp": 1738000000.12, "change": 0.20, "change_percent": 0.11, "direction": "up"}, "GOOGL": {...}, ...}

  ```

  Each per-ticker object matches `PriceUpdate.to_dict()`: `ticker`, `price`, `previous_price`, `timestamp` (Unix seconds), `change`, `change_percent`, `direction` (`"up"`/`"down"`/`"flat"`). `previous_price` is the ticker's *prior tick* (~500ms earlier), not a session-open or prior-close reference — there is no such reference price anywhere in this contract (see §10's watchlist panel note for how "change since page load" is derived instead). The frontend should replace its price map with each event's keys on receipt rather than merging deltas.
- Client handles reconnection automatically (EventSource has built-in retry)
- **Held positions are always tracked regardless of watchlist membership, via a one-way rule split across two endpoints:**
  - **On watchlist removal (`DELETE /api/watchlist/{ticker}`):** if the user has an open position in that ticker, the handler deletes only the `watchlist` row and must **not** call `MarketDataSource.remove_ticker()` — that method unconditionally evicts the ticker from the `PriceCache` too, which would kill live valuation for an open position. The market data source keeps producing updates for it (and, in Massive mode, keeps polling it) exactly as if it were still watchlisted. If there is no open position, the handler calls `remove_ticker()` normally, which both stops tracking and evicts the cache entry.
  - **On trade execution (`POST /api/portfolio/trade`):** whenever a trade brings a position's quantity to exactly zero, the handler must check whether that ticker is still on the watchlist. If it is not, call `source.remove_ticker()` at that point to stop tracking it and evict it from the cache/stream. Without this step a closed, unwatchlisted position would be tracked forever.
- **Removal is not immediately visible over SSE.** In the shipped `PriceCache.remove()`, evicting a ticker does not bump the cache's version counter, and `stream.py` only emits an event when that counter changes. So a `remove()` call produces no SSE event on its own — the removed ticker only disappears from clients on the *next* event triggered by some other ticker's price update, which could be up to ~500ms later (simulator) or, in the worst case, never (if no other ticker updates, e.g. all tickers removed). The frontend must not rely on the SSE stream alone to reflect a removal promptly: `DELETE /api/watchlist/{ticker}` and any trade that triggers `remove_ticker()` should drive the removal in the client's local state directly from that REST call's success response, treating the SSE stream as an eventually-consistent secondary signal, not the primary one for this specific transition.

---

## 7. Database

### SQLite with Startup Initialization

The backend initializes the database during FastAPI's `lifespan` startup hook — before the app accepts any HTTP/SSE requests and before the market-data or portfolio-snapshot background tasks start (both need `users_profile`/`watchlist`/`positions` to exist before their first read/write, per §6's "Ticker Tracking Set" and this section's snapshot rules). If the SQLite file doesn't exist or is missing tables, it creates the schema and seeds default data. If schema creation fails, startup fails loudly — the container must not come up and start serving against a partially-initialized database.

- No separate migration step
- No manual database setup
- Fresh Docker volumes start with a clean, seeded database automatically
- Schema evolution is intentionally unsupported: there is no version/migration mechanism. A schema change during development means deleting the SQLite file (or Docker volume) and letting it reseed.

### Schema

All tables include a `user_id` column defaulting to `"default"`. This is hardcoded for now (single-user) but enables future multi-user support without schema migration.

**users_profile** — User state (cash balance)
- `id` TEXT PRIMARY KEY (default: `"default"`)
- `cash_balance` REAL (default: `10000.0`)
- `created_at` TEXT (ISO timestamp)

**watchlist** — Tickers the user is watching
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `ticker` TEXT
- `added_at` TEXT (ISO timestamp)
- UNIQUE constraint on `(user_id, ticker)`

**positions** — Current holdings (one row per ticker per user)
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `ticker` TEXT
- `quantity` REAL (fractional shares supported)
- `avg_cost` REAL
- `updated_at` TEXT (ISO timestamp)
- UNIQUE constraint on `(user_id, ticker)`

**trades** — Trade history (append-only log)
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `ticker` TEXT
- `side` TEXT (`"buy"` or `"sell"`)
- `quantity` REAL (fractional shares supported)
- `price` REAL
- `executed_at` TEXT (ISO timestamp)

**portfolio_snapshots** — Portfolio value over time (for P&L chart). Recorded every 30 seconds by a background task, and immediately after each trade execution.
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `total_value` REAL
- `recorded_at` TEXT (ISO timestamp)

**chat_messages** — Conversation history with LLM
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `role` TEXT (`"user"` or `"assistant"`)
- `content` TEXT
- `actions` TEXT (JSON — trades executed, watchlist changes made; null for user messages)
- `created_at` TEXT (ISO timestamp)

### Default Seed Data

- One user profile: `id="default"`, `cash_balance=10000.0`
- Ten watchlist entries: AAPL, GOOGL, MSFT, AMZN, TSLA, NVDA, META, JPM, V, NFLX
- One initial `portfolio_snapshots` row, `total_value=10000.0`, `recorded_at` equal to `users_profile.created_at` — so the P&L chart has a baseline point immediately on first launch instead of an empty chart for up to 30 seconds.

### Portfolio Snapshot Semantics

- **Timing**: a snapshot is recorded (1) once at profile creation (the seed row above), (2) immediately after every trade commits (part of that trade's transaction, per "Transactions & Concurrency" above), and (3) every 30 seconds by a background task. The 30-second task starts counting from app startup and does not fire an extra snapshot immediately on boot — the seed row already covers that.
- **Valuation formula**: `total_value = cash_balance + Σ(quantity * current_price)` over open positions, using §8's Portfolio Metric Formulas. If a held ticker has no cached price at snapshot time (should be rare given §6's Ticker Tracking Set guarantee, but possible in a narrow startup window), that position's contribution is valued at its `avg_cost` as a fallback rather than skipped or treated as zero, so a single missing quote doesn't produce a visible portfolio-value cliff.
- **Timestamp format**: `recorded_at` (and every other `TEXT` "ISO timestamp" column in this schema) is UTC RFC 3339, e.g. `2026-08-01T22:15:30.123Z` — not a local time, and not the Unix-seconds format SSE uses (§6 keeps Unix seconds for `PriceUpdate.timestamp`; the two are intentionally different serializations for different transports).
- **Ordering/retention**: `GET /api/portfolio/history` (§8) returns all snapshots for the user ordered by `recorded_at` ascending. There is no retention/pruning policy — snapshots accumulate indefinitely for the life of the SQLite file. At one row per 30s this is a bounded, small growth rate for a course project and isn't worth adding a retention job for.
- The frontend's P&L chart (§10) plots `total_value` directly (not a P&L delta) against this baseline; a "profit" read is visual, relative to the $10,000 starting line, not a separately computed series.

### Money & Quantity Precision

- **Prices**: floats rounded to 2 decimals, matching the already-shipped `PriceCache.update()` (§6).
- **Cash and average cost**: floats rounded to 2 decimals on write (every `cash_balance` and `avg_cost` update rounds before persisting), so rounding error cannot accumulate across many trades.
- **Quantities**: floats, rounded to 6 decimal places on write. This is generous enough for realistic fractional-share amounts while bounding floating-point residue.
- **Closing a position**: a position is considered fully closed, and its `positions` row deleted (per "Transactions & Concurrency" above), when a sell brings `quantity` to `0` after rounding to 6 decimals — not when it's merely "close to zero." A sell for slightly more than the rounded holding (e.g. the UI offering a "sell all" that sends the exact held quantity) is expected to zero out exactly; the backend does not need a fuzzy epsilon check beyond that rounding step.

### Transactions & Concurrency

- The backend runs as a **single process, single Uvicorn worker** (no `--workers N`, no multi-container replicas). This is a requirement, not an implementation detail: the concurrency guarantees below depend on a single in-process lock, which only works within one process. A future multi-worker or multi-instance deployment would need a different mechanism (e.g. `BEGIN IMMEDIATE` transactions with retry, or moving off SQLite) and is explicitly out of scope for this project.
- Each individual trade (manual or LLM-issued) executes inside one SQLite transaction (opened with `BEGIN IMMEDIATE`, so the write lock is acquired up front rather than upgraded mid-transaction, avoiding `SQLITE_BUSY` races between the trade lock below and any other writer) that atomically: validates the current cash balance/position, updates `users_profile.cash_balance`, upserts the `positions` row (or deletes it if the trade brings quantity to exactly zero — a full sell removes the row rather than leaving a zero-quantity one), inserts the `trades` row, and inserts the resulting `portfolio_snapshots` row. These changes commit or roll back together; a trade never partially applies (e.g. cash debited with no matching position change). Connections use a busy timeout (e.g. 5s) as a defense-in-depth measure, not as the primary concurrency mechanism — that's the in-process lock below.
- An LLM trade batch (§9) is **not** atomic as a whole: each trade is validated and committed as its own transaction, in order, against the cash/position balance as updated by whichever prior trades in the batch already committed. A failure does **not** abort the rest of the batch — every trade in the batch is attempted, and each independently ends up `executed` or `failed` (§9's response envelope has exactly these two statuses; there is no third "skipped" state). So if trade 2 of 3 fails validation (e.g. insufficient cash), trade 1's success stays committed and trade 3 is still attempted afterward, succeeding or failing on its own merits against the balance as it stands at that point.
- Because this is a single-user app backed by one SQLite file, trade execution (manual or chat-triggered) and the 30-second portfolio-snapshot background task must never interleave a read-validate-write sequence for the same user. The backend serializes all trade execution and ad hoc snapshot writes behind a single in-process `asyncio.Lock` (sufficient given the single-worker requirement above) so two concurrent buys can never both validate against the same stale cash balance and jointly overspend it.

---

## 8. API Endpoints

### Response & Error Conventions

Applies to every `/api/*` endpoint except the SSE stream:

- **Ticker normalization**: the backend upper-cases and trims whitespace on every ticker input (watchlist add/delete, manual trade, chat-driven trade/watchlist change) before it touches the DB or the market data source, so `"aapl"` and `"AAPL"` always resolve to the same entry. A normalized ticker that is empty or contains anything other than `A-Z`/`.`/`-` (e.g. `""`, `"12X"`, emoji) is rejected as `invalid_ticker` before any DB or market-data call.
- **Errors**: any non-2xx response body is `{"error": {"code": "<snake_case_code>", "message": "<human-readable>"}}`. This includes errors FastAPI would otherwise generate itself: request-body validation failures (missing/wrong-typed fields) normally produce FastAPI's default `422` body, but a global exception handler translates those into this same envelope with `code: "validation_error"` and `status: 422`, so the frontend only ever has to handle one error shape. Common codes:

| Code | Status | When |
|---|---|---|
| `validation_error` | 422 | Malformed/missing body fields (including FastAPI's own request-model validation), or non-numeric/zero/negative quantity |
| `invalid_ticker` | 400 | Ticker fails the normalization/syntax check above |
| `invalid_side` | 400 | `POST /api/portfolio/trade` `side` is not `"buy"` or `"sell"` |
| `not_watchlisted` | 404 | `DELETE /api/watchlist/{ticker}` for a ticker with no `watchlist` row |
| `no_position` | 404 | Sell for a ticker with no open `positions` row (or a sell quantity exceeding the held amount — see `insufficient_shares` below for the latter) |
| `duplicate_ticker` | 409 | `POST /api/watchlist` for a ticker already on the list |
| `insufficient_cash` | 400 | Buy exceeds cash balance |
| `insufficient_shares` | 400 | Sell exceeds held quantity (position exists, but not enough of it) |
| `quote_unavailable` | 409 | Trade attempted before the market data source has produced a first price for that ticker (§6 "Tradeable Symbols") — a real race right after adding a new ticker, especially in Massive mode where the first poll can be up to 15s away, or a symbol Massive never quotes. Reject immediately rather than blocking the request. |
| `chat_unavailable` | 503 | `POST /api/chat` with no `OPENROUTER_API_KEY` configured and `LLM_MOCK` not `"true"` (§5) — the only chat failure mode that's an HTTP error; everything past that point (malformed output, provider/network failure) degrades gracefully in-band as a normal `200` chat turn, per §9 |
| `internal_error` | 500 | Any unhandled server error; still returned in this envelope via a catch-all exception handler, never a bare framework error page |

- **Numeric representation**: prices are floats rounded to 2 decimals (matches `PriceCache.update()`); cash, average cost, and quantities follow §7's "Money & Quantity Precision" rules (2-decimal money, 6-decimal quantities).
- **Timestamps**: every REST/JSON timestamp field is UTC RFC 3339 (e.g. `2026-08-01T22:15:30.123Z`), matching the DB schema's `TEXT` "ISO timestamp" columns (§7). This is deliberately different from the SSE payload, which uses Unix seconds per `PriceUpdate.to_dict()` (§6) — REST and SSE are separate transports with separate, already-fixed formats.
- **Success shape**: successful responses return the affected resource(s) directly — e.g. `POST /api/portfolio/trade` returns the updated position and cash balance; `POST /api/watchlist` returns the created watchlist entry with its current price if already cached, or `price: null` if the ticker has no quote yet. `DELETE /api/watchlist/{ticker}` returns `204 No Content` on success (no body).

### Portfolio Metric Formulas

- **Position market value** = `quantity * current_price` (using the live `PriceCache` price; if no price is cached, treat as unpriceable and fall back to `avg_cost`, matching §7's snapshot valuation rule — this should be rare given §6's Ticker Tracking Set guarantee).
- **Position unrealized P&L** = `(current_price - avg_cost) * quantity`.
- **Position % change** = `(current_price - avg_cost) / avg_cost * 100`. `avg_cost` cannot be `0` under normal buy-only cost-basis accounting (a position only exists after at least one buy at a positive price), so this is not guarded further.
- **Total portfolio value** = `cash_balance + Σ(position market value)` across all open positions.
- **Aggregate unrealized P&L** = `Σ(position unrealized P&L)` across all open positions.
- **Position weight** (heatmap sizing, §10) = `position market value / total portfolio value` — against total value *including* cash, not positions-only, so an all-cash portfolio renders 0% everywhere instead of a divide-by-zero. A fresh account with zero positions renders an empty heatmap with a placeholder message (e.g. "No positions yet"), not an error or a blank panel.

### Response Examples

```
GET /api/portfolio → 200
{
  "cash_balance": 8450.00,
  "total_value": 10120.35,
  "unrealized_pnl": 120.35,
  "positions": [
    {"ticker": "AAPL", "quantity": 10, "avg_cost": 188.00, "current_price": 191.20,
     "market_value": 1912.00, "unrealized_pnl": 32.00, "change_percent": 1.70}
  ]
}

GET /api/portfolio/history → 200
{"snapshots": [{"total_value": 10000.00, "recorded_at": "2026-08-01T20:00:00.000Z"}, ...]}

GET /api/watchlist → 200
{"watchlist": [{"ticker": "AAPL", "added_at": "2026-08-01T20:00:00.000Z", "price": 191.20}]}

POST /api/watchlist {"ticker": "pypl"} → 201
{"ticker": "PYPL", "added_at": "2026-08-01T22:00:00.000Z", "price": null}

GET /api/health → 200
{"status": "ok", "chat_enabled": false}
```

### Market Data
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stream/prices` | SSE stream of live price updates |

### Portfolio
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolio` | Current positions, cash balance, total value, unrealized P&L |
| POST | `/api/portfolio/trade` | Execute a trade: `{ticker, quantity, side}` |
| GET | `/api/portfolio/history` | Portfolio value snapshots over time (for P&L chart) |

`POST /api/portfolio/trade` must also apply the position-close ticker-unsubscription rule from §6 when a trade zeroes out a position.

### Watchlist
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/watchlist` | Current watchlist tickers with latest prices |
| POST | `/api/watchlist` | Add a ticker: `{ticker}` |
| DELETE | `/api/watchlist/{ticker}` | Remove a ticker (see §6 for the open-position exception) |

### Chat
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | Send a message (`{"message": "..."}`), receive the response envelope defined in §9 (message + per-action execution results) |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Returns `{"status": "ok", "chat_enabled": <bool>}`. `chat_enabled` reflects whether `OPENROUTER_API_KEY` is set or `LLM_MOCK=true` (§5); it does not affect `status` — a missing chat key degrades one feature, it doesn't make the app unhealthy. `status` is only `"ok"` once DB startup init (§7) has completed. |

---

## 9. LLM Integration

When writing code to make calls to LLMs, use the `cerebras` skill (invoke it by that name — its frontmatter identifies it internally as `cerebras-inference`, but the name you invoke via the Skill tool is `cerebras`) to use LiteLLM via OpenRouter to the `openrouter/openai/gpt-oss-120b` model with Cerebras as the inference provider. Structured Outputs should be used to interpret the results.

There is an OPENROUTER_API_KEY in the .env file in the project root.

### How It Works

When the user sends a chat message, the backend:

1. Inserts a `chat_messages` row for the user's message immediately (`role="user"`, `content=<user text>`, `actions=null`) — before calling the LLM, so the message is never lost even if everything past this point fails
2. Loads the user's current portfolio context (cash, positions with P&L, watchlist with live prices, total portfolio value)
3. Loads recent conversation history from the `chat_messages` table — the last 20 messages (10 user/assistant turns) **excluding the row just inserted in step 1**, oldest-first. Each past assistant turn's `actions` JSON (the executed-outcome envelope from a prior turn) is serialized into that turn's history entry, so the model can see real outcomes of its own prior proposals, not just its own `message` text.
4. Constructs a prompt with a system message, portfolio context, conversation history (including prior actions per step 3), and the user's new message
5. Calls the LLM via LiteLLM → OpenRouter, requesting structured output, using the `cerebras` skill
6. Parses the complete structured JSON response. If the call fails outright (timeout, network error, non-2xx from the provider) or the response fails to parse as valid structured output, skip to step 9 with no trades/watchlist changes executed and `message` set to the generic fallback (§9 "Malformed LLM Output") — this is not an HTTP error (§8's `chat_unavailable` only covers the missing-key case); it's a normal chat turn that happens to carry a generic reply
7. Auto-executes proposed changes in a fixed order: all `trades` first (in array order, per "Transactions & Concurrency" in §7), then all `watchlist_changes` (in array order). A failure in either array does not block or skip later entries in either array — every proposed action is attempted independently, exactly as within the `trades` array itself (§7)
8. Builds the response envelope (`message` + `actions`, see below)
9. Inserts a `chat_messages` row for the assistant's turn (`role="assistant"`, `content=<message>`, `actions=<the actions array from step 8, as JSON, or null if step 6 short-circuited>`)
10. Returns the response envelope to the frontend (no token-by-token streaming — Cerebras inference is fast enough that a loading indicator is sufficient)

### Structured Output Schema

The LLM is instructed to respond with JSON matching this schema:

```json
{
  "message": "Your conversational response to the user",
  "trades": [
    {"ticker": "AAPL", "side": "buy", "quantity": 10}
  ],
  "watchlist_changes": [
    {"ticker": "PYPL", "action": "add"}
  ]
}
```

- `message` (required): The conversational text shown to the user
- `trades` (optional): Array of trades to auto-execute. Each trade goes through the same validation as manual trades (sufficient cash for buys, sufficient shares for sells). Trades are validated and executed sequentially, in the order returned, each against the cash/position balance as updated by the prior trades in the same batch — so two buys can't jointly overspend cash that only one of them actually has.
- `watchlist_changes` (optional): Array of watchlist modifications

This schema is what the LLM *proposes*, generated in the same call before any execution happens — the model cannot know yet whether a given trade will pass validation. It is never returned to the frontend as-is; see "Response Envelope" below for what `POST /api/chat` actually returns.

### Auto-Execution

Trades and watchlist changes specified by the LLM execute automatically — no confirmation dialog. This is a deliberate design choice:
- It's a simulated environment with fake money, so the stakes are zero
- It creates an impressive, fluid demo experience
- It demonstrates agentic AI capabilities — the core theme of the course

If a trade fails validation (e.g., insufficient cash), it is reported as a failed action in the response envelope, not woven into the LLM's `message` text — the model wrote `message` before execution ran, so it cannot react to a failure within the same turn. The user sees the failure immediately via the `actions` list; the LLM only "learns" about it once that turn's persisted `actions` are serialized into conversation history on a later turn (§9 "How It Works" step 3).

### Response Envelope

`POST /api/chat` does not return the raw structured-output schema above. After executing proposed trades/watchlist changes per the rules in this section and in §7 (Transactions & Concurrency), the backend builds a separate, server-generated envelope:

```json
{
  "message": "On it — buying 10 AAPL, buying 5 TSLA, and adding PYPL to your watchlist.",
  "actions": [
    {"type": "trade", "ticker": "AAPL", "side": "buy", "quantity": 10, "status": "executed", "fill_price": 191.20},
    {"type": "trade", "ticker": "TSLA", "side": "buy", "quantity": 5, "status": "failed", "error": "insufficient cash"},
    {"type": "watchlist_add", "ticker": "PYPL", "status": "executed"}
  ]
}
```

Note that `message` here describes what the LLM *intends* ("buying 5 TSLA"), not what actually happened — it was generated before execution ran, so it has no way to know the TSLA buy would fail. The `actions` array is the only accurate record of outcomes; the frontend must render both (the LLM's narration and the per-action results), not treat `message` as a summary of what occurred. This is expected behavior, not a bug — see the "Auto-Execution" note above.

- `message` is the LLM's conversational text, unmodified.
- `actions` is server-generated: one entry per proposed trade/watchlist change, in the order attempted, each carrying `status: "executed" | "failed"`, an `error` string on failure, and `fill_price` for executed trades.
- This executed-outcome envelope — not the LLM's raw proposal — is both what `POST /api/chat` returns and what gets persisted into `chat_messages.actions` (§7), so chat history reloads and later LLM turns see real outcomes, not intentions.
- `POST /api/chat` request body: `{"message": "<user text>"}`.

### Malformed LLM Output

If the LLM's response fails to parse as valid structured output, no trades or watchlist changes are executed. The chat shows a generic, plain-language error message (e.g. "Sorry, I had trouble processing that — please try again") in place of an assistant reply. No automatic retry.

### System Prompt Guidance

The LLM should be prompted as "FinAlly, an AI trading assistant" with instructions to:
- Analyze portfolio composition, risk concentration, and P&L
- Suggest trades with reasoning
- Execute trades when the user asks or agrees
- Manage the watchlist proactively
- Be concise and data-driven in responses
- Always respond with valid structured JSON

### LLM Mock Mode

When `LLM_MOCK=true`, the backend returns deterministic mock responses instead of calling OpenRouter. This enables:
- Fast, free, reproducible E2E tests
- Development without an API key
- CI/CD pipelines

---

## 10. Frontend Design

### Layout

The frontend is a single-page application with a dense, terminal-inspired layout. The specific component architecture and layout system is up to the Frontend Engineer, but the UI should include these elements:

- **Watchlist panel** — grid/table of watched tickers with: ticker symbol, current price (flashing green/red on change), change % since page load, and a sparkline mini-chart (accumulated from SSE since page load). This is not a true daily/session change — the market-data contract (§6) carries no session-open or prior-close reference price, only the previous ~500ms tick. The frontend computes it client-side as `(current_price - first_price_seen) / first_price_seen`, where `first_price_seen` is the first SSE update received for that ticker after page load (or after the ticker is added to the watchlist, if added later) — the same reference point the sparkline uses. It resets on every page reload; this is an accepted simplification, not a bug.
- **Main chart area** — larger chart for the currently selected ticker, with at minimum price over time. Clicking a ticker in the watchlist selects it here.
- **Portfolio heatmap** — treemap visualization where each rectangle is a position, sized by portfolio weight, colored by P&L (green = profit, red = loss)
- **P&L chart** — line chart showing total portfolio value over time, using data from `portfolio_snapshots`
- **Positions table** — tabular view of all positions: ticker, quantity, avg cost, current price, unrealized P&L, % change
- **Trade bar** — simple input area: ticker field, quantity field, buy button, sell button. Market orders, instant fill. Quantity field accepts fractional (decimal) input, consistent with chat-driven trades — one shared quantity handling path regardless of entry point.
- **AI chat panel** — docked/collapsible sidebar. Message input, scrolling conversation history, loading indicator while waiting for LLM response. Trade executions and watchlist changes shown inline as confirmations.
- **Header** — portfolio total value (updating live), connection status indicator, cash balance

### Technical Notes

- Use `EventSource` for SSE connection to `/api/stream/prices`
- Canvas-based charting library preferred (Lightweight Charts or Recharts) for performance
- Price flash effect: on receiving a new price, briefly apply a CSS class with background color transition, then remove it
- All API calls go to the same origin (`/api/*`) — no CORS configuration needed
- Tailwind CSS for styling with a custom dark theme

---

## 11. Docker & Deployment

### Multi-Stage Dockerfile

The `Dockerfile` lives at the repo root; `docker build -t finally .` is run from the repo root so the build context includes both `frontend/` and `backend/`. `.env` is never copied into the image (it holds secrets) — it's supplied at container run time via `--env-file`, not at build time.

```
Stage 1: Node 20 slim
  - Copy frontend/
  - npm install && npm run build (produces static export to frontend/out/, per Next's output: 'export')

Stage 2: Python 3.12 slim
  - WORKDIR /app
  - Install uv
  - Copy backend/ to /app
  - uv sync --frozen --no-dev (production install from the lockfile; no dev/test extras — contrast with `uv sync --extra dev` for local backend development per backend/CLAUDE.md)
  - Copy frontend/out/ (Stage 1's export) to /app/static
  - Expose port 8000
  - CMD: uvicorn serving the FastAPI app on `0.0.0.0:8000` (the exact `module:app` path is up to the Backend agent, per §4's "internal structure" note) — single process, no `--workers` flag, required by §7's "Transactions & Concurrency"
```

FastAPI serves the static frontend files (from `/app/static`) and all API routes on port 8000. Route precedence is fixed: `/api/*` and `/api/stream/*` routers are registered first, so an unmatched path under `/api/` always returns a JSON `404` in the §8 error envelope — it never falls through to the frontend's `index.html`. Every other path (including unknown ones, since this is a single-page app with client-side routing) falls through to serving the static export's `index.html`; static assets (`_next/`, etc.) are served directly by path.

**Test files are load-bearing for Stage 1.** `npm run build` runs Next's production `tsc` typecheck over the whole TypeScript project, which by default includes `__tests__/**` — a type error in a test file fails `docker build`, not just `npm test`. The frontend project splits this deliberately: `tsconfig.json` (what `next build` uses) excludes tests, and a separate `tsconfig.test.json` re-includes them so `npm run typecheck` still fully type-checks test code against real app types. Don't assume "it's just a test file" makes a type error build-safe — verify against `tsconfig.json`'s `exclude` list, not intuition.

### Docker Volume

The SQLite database persists via a **host bind mount** of the repo's `db/` directory (not a named volume — a named volume would not map to the host `db/` directory the rest of this plan describes, e.g. §4's tree and §7's "runtime volume mount point"):

```bash
docker run --name finally -v "$(pwd)/db:/app/db" -p 8000:8000 --env-file .env finally
```

(`scripts/start_windows.ps1` uses the PowerShell equivalent, e.g. `${PWD}` or an absolute path, in place of `$(pwd)`.) The backend writes to `/app/db/finally.db` inside the container, configurable via a `DB_PATH` environment variable (default `/app/db/finally.db`) so tests can point at an isolated file (§12). The explicit `--name finally` gives the idempotent start/stop scripts below a stable target for `docker stop`/`docker rm`.

**Git Bash / MSYS trap:** running the raw command above from Git Bash on Windows silently breaks persistence — MSYS path conversion rewrites the container-side `/app/db` argument into a host path (e.g. `C:/Program Files/Git/app/db`), so the mount lands at a bogus destination, the app writes its DB into the container's writable layer instead, and all data is lost on `docker rm` — while the app reports healthy the whole time. Prefix the command with `MSYS_NO_PATHCONV=1` if invoking `docker run` directly from Git Bash, or just use `scripts/start_windows.ps1` (plain PowerShell, unaffected) or `scripts/start_mac.sh` (no MSYS rewriting), which is the recommended path anyway.

### Start/Stop Scripts

**`scripts/start_mac.sh`** (macOS/Linux):
- Builds the Docker image if not already built (or if `--build` flag passed)
- Runs the container with the volume mount, port mapping, and `.env` file
- Prints the URL to access the app
- Optionally opens the browser

**`scripts/stop_mac.sh`** (macOS/Linux):
- Stops and removes the running container
- Does NOT remove the volume (data persists)

**`scripts/start_windows.ps1`** / **`scripts/stop_windows.ps1`**: PowerShell equivalents for Windows.

All scripts should be idempotent — safe to run multiple times.

### Optional Cloud Deployment

The container is designed to deploy to AWS App Runner, Render, or any container platform. A Terraform configuration for App Runner may be provided in a `deploy/` directory as a stretch goal, but is not part of the core build.

---

## 12. Testing Strategy

### Unit Tests (within `frontend/` and `backend/`)

**Backend (pytest)**:
- Market data: simulator generates valid prices, GBM math is correct (using an injectable/seeded RNG — the simulator must accept an optional seed or generator so a test can assert exact output, not just statistical properties), Massive API response parsing works, both implementations conform to the abstract interface
- Portfolio: trade execution logic, P&L calculations, edge cases (selling more than owned, buying with insufficient cash, selling at a loss)
- LLM: structured output parsing handles all valid schemas, graceful handling of malformed responses, trade validation within chat flow
- API routes: correct status codes, response shapes, error handling

**Frontend (React Testing Library or similar)**:
- Component rendering with mock data
- Price flash animation triggers correctly on price changes
- Watchlist CRUD operations
- Portfolio display calculations
- Chat message rendering and loading state

### Determinism & Test Hooks

- **Mock LLM fixtures**: `LLM_MOCK=true` maps recognizable substrings/patterns in the incoming user message to canned structured-output responses (e.g. a message containing `"buy 10 aapl"` deterministically returns a `trades` array buying 10 AAPL) — defined as a fixture table the E2E suite and backend tests both use, so "AI chat (mocked)" scenarios are reproducible rather than freeform.
- **Fast intervals for tests**: the market-data tick interval (~500ms) and the portfolio-snapshot interval (30s) are both configurable via environment variables (e.g. `MARKET_TICK_SECONDS`, `SNAPSHOT_INTERVAL_SECONDS`), defaulting to the production values above but overridable to sub-second in `test/docker-compose.test.yml` so E2E tests don't need to wait out a real 30-second cycle.
- **Isolated database per run**: the E2E container sets `DB_PATH` (§11) to a fresh file each run (or the compose file mounts a throwaway volume), so tests never share state with a developer's local `db/finally.db` or a previous run.
- **Readiness**: E2E setup polls `GET /api/health` until `status: "ok"` (§8) before starting scenarios, rather than a fixed sleep.
- **SSE disconnect/reconnect**: forced via the test harness closing the underlying HTTP connection to `/api/stream/prices` (e.g. Playwright's request interception/abort, or a proxy in front of the app container that can be told to drop the connection) and then asserting the client's `EventSource` re-establishes and resumes receiving events — `EventSource`'s retry is otherwise entirely client-side and unobservable from outside the browser.
- **Heatmap color thresholds**: rectangles are green when unrealized P&L (§8 formulas) is `> 0`, red when `< 0`, and neutral/gray when exactly `0` (a same-day break-even or a freshly opened position) — this is the assertable rule for "correct colors" in the scenario below.

### E2E Tests (in `test/`)

**Infrastructure**: A separate `docker-compose.test.yml` in `test/` that spins up the app container plus a Playwright container. This keeps browser dependencies out of the production image.

**Environment**: Tests run with `LLM_MOCK=true` by default for speed and determinism, plus the fast intervals and isolated database described above.

**Key Scenarios**:
- Fresh start: default watchlist appears, $10k balance shown, prices are streaming
- Add and remove a ticker from the watchlist
- Buy shares: cash decreases, position appears, portfolio updates
- Sell shares: cash increases, position updates or disappears
- Portfolio visualization: heatmap renders with correct colors, P&L chart has data points
- AI chat (mocked): send a message, receive a response, trade execution appears inline
- SSE resilience: disconnect and verify reconnection
