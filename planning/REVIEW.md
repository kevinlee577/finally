# Review of `planning/PLAN.md`

Reviewed against the live repository state on 2026-08-01 (market-data module built under `backend/app/market/`; `frontend/`, `backend/db/`, `db/`, `test/`, `scripts/` do not exist yet). This supersedes the previous contents of this file.

## Overall assessment

The vision, architecture, and directory boundaries are clear enough to split work across frontend/backend/testing agents. Section 13 already resolved several earlier ambiguities (chat history window, multi-trade validation order, fractional quantities, malformed-output handling, dropped-position tracking rule, `docker-compose.yml` removal, `user_id` boilerplate). What remains is a set of **contract gaps between the plan's prose and the market-data code that already exists**, plus the usual missing wire-format/response-shape details that block independent frontend/backend/E2E work. The market-data-specific findings below are new — they come from reading the actual built module (`backend/app/market/`), not just the plan text, and one of them (finding 1) is a genuine conflict between §6's own resolved rule and the shipped `MarketDataSource` interface.

## High-priority findings

### 1. ~~The "keep tracking held positions after watchlist removal" rule has no supported implementation path, and no one ever re-evicts~~ **Resolved (2026-08-01, §6/§8):**

§6's resolved note says: *"The watchlist-delete endpoint must check for an open position before calling `PriceCache.remove()`."* But the only two operations the shipped `MarketDataSource` interface (`backend/app/market/interface.py`, implemented identically in `simulator.py` and `massive_client.py`) exposes are:

- `remove_ticker(ticker)` — stops the source from tracking the ticker **and unconditionally calls `self._cache.remove(ticker)`** (see `SimulatorDataSource.remove_ticker` / `MassiveDataSource.remove_ticker`).
- Nothing else touches the cache's contents besides `PriceCache.update()`.

So "don't evict if a position is open" only works if the watchlist-delete handler calls `PriceCache.remove()` directly and never calls `source.remove_ticker()` — bypassing the source abstraction entirely. That's workable (the simulator/Massive poller just keeps updating a ticker nobody asked it to stop tracking), but the plan doesn't say so explicitly, and it creates a second, unaddressed problem: **once the position is later fully closed, nothing in the plan ever calls `source.remove_ticker()` for it.** The ticker is never actually unsubscribed — the simulator keeps computing it and Massive keeps polling it (burning rate-limited API calls) indefinitely, and it never leaves the SSE stream, even though the user removed it from the watchlist and closed the position.

Add an explicit rule: when a trade brings a position's quantity to zero, check whether the ticker is still on the watchlist; if not, call `source.remove_ticker()` at that point. State plainly that the watchlist-delete endpoint must go through `PriceCache` directly (not `source.remove_ticker()`) when a position is open, since that's the only way the documented behavior is achievable with the current interface.

### 2. ~~"Daily change %" cannot be produced from the shipped market-data model~~ **Resolved (2026-08-01, §10):**

The watchlist UI (§10) requires "daily change %." The actual `PriceUpdate` model (`backend/app/market/models.py`) only carries `price`, `previous_price` (the *prior tick*, ~500ms earlier — confirmed by `PriceCache.update()`, which sets `previous_price = prev.price` from the last cached update), `timestamp`, and derives `change`/`change_percent`/`direction` from those two. There is no notion of a session-open or prior-close reference price anywhere in the built module, the SSE payload, or the plan's data model in §6/§8.

Either add a `previous_close`/`session_open` field to `PriceUpdate` and the SSE/watchlist payload (with an explicit rule for what the simulator uses as "open" — e.g., the seed price at stream start, reset how/when), or rename the UI requirement to "change since page load" and make sure §10's wording and any frontend spec agree. As written, a frontend agent and a backend agent can each pick a different interpretation and silently diverge.

### 3. ~~SSE wire format in §6 doesn't match the already-implemented endpoint~~ **Resolved (2026-08-01, §6):**

§6 says "Each SSE event contains ticker, price, previous price, timestamp, and change direction," which reads as one event per ticker. The shipped `stream.py` instead sends **one batched event containing every tracked ticker as a JSON object keyed by symbol**, only when the cache's global version counter changes (i.e., on *any* ticker's update, not just changed ones):

```
retry: 1000

data: {"AAPL": {"ticker": "AAPL", "price": 190.5, "previous_price": 190.3, "timestamp": 1234.5, "change": 0.2, "change_percent": 0.11, "direction": "up"}, "GOOGL": {...}, ...}

```

No `event:` name or `id:` field is sent; every event is the default `message` type and always carries the full snapshot of all tickers (not a diff). Since this component is already built and frozen, the plan text is simply wrong and will mislead the frontend and E2E agents, who have no other source of truth for the wire format. Replace §6's description with the actual format above (or point to `backend/app/market/stream.py` / `backend/CLAUDE.md` as the source of truth), and specify how the frontend should key off the payload (object keyed by ticker, not an array).

### 4. ~~Trade execution needs an explicit atomicity and concurrency contract~~ **Resolved (2026-08-01, §7 "Transactions & Concurrency"):**

The plan specifies sequential validation for an LLM trade batch (§9) but not whether it's atomic (all-or-nothing) or partial-success, and nothing describes how concurrent manual trades, chat-triggered trades, and the 30-second snapshot task avoid lost updates against SQLite (which serializes writes but not read-modify-write sequences at the application level).

Specify that each individual trade runs in one DB transaction covering cash/position read-validate-write, trade-log insert, and the post-trade snapshot; state whether a multi-trade LLM batch commits each trade independently as it validates (so an earlier success survives a later failure) or rolls back the whole batch on any single failure. The current chat-flow wording ("each trade validated against the balance as updated by prior trades in the same batch") already implies per-trade commit, but never says so outright — make it explicit either way.

### 5. ~~Chat response envelope conflates proposed actions with actual outcomes~~ **Resolved (2026-08-01, §9 "Response Envelope"):**

§9's structured-output schema (`trades`, `watchlist_changes`) describes what the LLM *wants* to do. Execution can reject a trade (insufficient cash/shares) or a watchlist op (duplicate/unknown ticker). The plan says the failure is "included in the chat response" but the LLM has already written `message` before execution happens in the same call — it cannot narrate a failure it doesn't know about yet.

Define a response envelope distinct from the LLM's raw schema: `{message, actions: [{type, ticker, ..., status: "executed"|"failed", error?}]}`, populated by the backend after execution, and clarify whether `chat_messages.actions` (§7) persists the LLM's proposal, the execution result, or both. Also specify the actual request body for `POST /api/chat` (§8 lists no request schema at all — presumably `{message: string}`, but this is never stated).

### 6. ~~API response/error contracts are underspecified across all `/api/*` endpoints~~ **Resolved (2026-08-01, §8 "Response & Error Conventions"):**

No endpoint in §8 has a documented response shape, status code, or error format. Concretely unresolved: unknown/invalid ticker on `POST /api/watchlist` (does the simulator's fallback of fabricating a random price for unrecognized tickers apply, or should the backend validate against a known symbol list?), duplicate watchlist add, `DELETE` of a ticker not on the list, zero/negative/non-numeric quantity, selling more shares than held, buying with insufficient cash, and trading a ticker with no price yet in the cache (a real possibility — `POST /api/watchlist` can add a ticker and the trade endpoint could be hit before the next simulator tick or Massive poll populates it, especially in Massive mode where the first poll may be up to 15s away).

Add request/response examples (or a minimal OpenAPI fragment) per endpoint: field names/types, HTTP status per failure mode, and a consistent error payload shape. Without this, frontend and E2E agents will each invent their own guess and diverge from the backend's actual behavior.

## Medium-priority findings

### 7. ~~Database initialization timing is still inconsistent between §4 and §7~~ **Resolved (2026-08-02, §4/§7/README):**

§4: "The backend lazily initializes the database on first request." §7: "The backend checks for the SQLite database on startup (or first request)." These describe different lifecycles (deferred-until-first-call vs. eager-at-boot). Pick one — initializing during FastAPI's startup/lifespan hook is simpler to reason about for the background snapshot/market-data tasks, which need the DB (or at least the profile row) to exist before their first write.

### 8. ~~Portfolio metrics need formulas and a cold-start baseline~~ **Resolved (2026-08-02, §7/§8):**

"Unrealized P&L," "% change," and "portfolio weight" (§10 heatmap) are named but not defined. Specify whether weight is position market value ÷ (cash + positions) or ÷ positions-only, and what a fresh account with zero positions renders (empty heatmap vs. placeholder). Also: `portfolio_snapshots` are recorded every 30s and after each trade (§7) — insert an initial snapshot at profile creation so the P&L chart isn't empty for up to 30 seconds after first launch.

### 9. ~~Ticker lifecycle / registration ownership isn't fully specified~~ **Resolved (2026-08-02, §6 "Ticker Tracking Set" / "Tradeable Symbols"):**

Related to finding 1 and 6: nothing states who calls `source.add_ticker()` when a ticker is added to the watchlist (presumably the `POST /api/watchlist` handler), what ticker normalization applies (case, whitespace — `MassiveDataSource` already upper-cases/strips internally in `add_ticker`/`remove_ticker`, but `SimulatorDataSource` does not, so an unnormalized ticker could produce two cache entries for what the user thinks is one symbol, e.g. `"aapl"` vs `"AAPL"`), and what "no acceptable quote yet" means for trade execution (reject with an error, or block until the cache has an entry?).

### 10. ~~`db/finally.db` still isn't covered by `.gitignore`~~ **Resolved (2026-08-02):**

Confirmed against the current `.gitignore` (present in the repo root): it has the Django-boilerplate `db.sqlite3` / `db.sqlite3-journal` entries but nothing matching `db/finally.db`, its `-wal`/`-shm` sidecars, or the `db/` directory generally. §13's own "Feedback" bullet already flags this as unresolved — it's still true today and should be fixed before the DB layer lands (add e.g. `/db/*.db*`).

### 11. ~~`.env.example` still doesn't exist~~ **Resolved (2026-08-02):**

Also already flagged as open in §13. `README.md`'s Quick Start (`cp .env.example .env`) and §4's directory tree both reference it as if committed; it isn't in `git ls-files`. Low effort, should be created alongside the first backend PR that needs `.env` (or now, since it's just `OPENROUTER_API_KEY=` / `MASSIVE_API_KEY=` / `LLM_MOCK=false` placeholders per §5).

### 12. ~~First-launch promise vs. required API key~~ **Resolved (2026-08-02, §5/§8):**

§2 promises a working app after "a single Docker command," no setup. §5/README mark `OPENROUTER_API_KEY` as required and give no fallback. Decide and document: does the app boot and serve prices/portfolio/watchlist with chat disabled/erroring if the key is absent, or does it fail to start? This also affects what `/api/health` should report (§8) — healthy-without-chat vs. unhealthy.

### 13. ~~Docker volume example doesn't match the documented bind-mount directory~~ **Resolved (2026-08-02, §11):**

§11's example (`docker run -v finally-data:/app/db ...`) uses a named volume, while §4's directory tree and the "Docker Volume" prose both describe `db/` at the project root as the mount target. A named volume and a host bind-mount are different mechanisms with different backup/inspection stories for students. Pick one and make the example and the directory-structure claim agree; also name the container explicitly so the idempotent start/stop scripts (§11) have something stable to target with `docker stop`/`docker rm`.

### 14. ~~Skill name mismatch: "cerebras-inference" vs. installed skill "cerebras"~~ **Resolved (2026-08-02, §9):**

§9 instructs implementers to "use cerebras-inference skill." The installed skill directory is `.claude/skills/cerebras/SKILL.md`; its frontmatter `name:` field is `cerebras-inference` (matching the plan), but it's exposed to agents in the skill listing under the short name `cerebras`. Minor, but worth a consistent name in the plan so an agent invoking it by the listed name doesn't wonder if it's the wrong skill.

### 15. ~~Test-observability items from the plan remain impractical as written~~ **Resolved (2026-08-02, §12):**

"GBM math is correct" (§12) needs a seeded RNG or injected `numpy` generator — `GBMSimulator` currently uses module-level `np.random.standard_normal`/`random.random()` with no seed hook, so a unit test can assert statistical properties at best, not determinism. SSE reconnect testing needs a defined way to force a disconnect (kill the container's network, or an injectable endpoint) since `EventSource`'s retry is client-side and opaque to Playwright without one. Heatmap "correct colors" needs explicit thresholds (e.g., P&L sign, or banded by magnitude). Add these as concrete test hooks/specs, ideally near §12.

## Repository/document hygiene

- The existing review note correctly identifies that `db/finally.db` is not ignored; add `/db/*.db`, journal/WAL sidecars, or equivalent before database work begins.
- The instruction to use a `cerebras-inference` skill is not portable unless every implementing environment has that skill. Keep the model/provider requirements in the plan, but put tool-specific agent instructions in the environment that supplies the skill or provide a normal implementation fallback.
- Consider moving section 13 out of the product specification after its two remaining repository issues are resolved. Resolved review history makes the normative contract harder to scan.

## Recommended next steps

1. Resolve finding 1 (ticker lifecycle on watchlist-removal-with-open-position) before the portfolio/watchlist backend work starts — it's a correctness gap, not just a documentation gap.
2. Reconcile §6 with the shipped SSE format (finding 3) and settle the daily-change-% question (finding 2) before the frontend agent builds the watchlist panel against the plan text.
3. Add the missing wire contracts as a short appendix: SSE payload example (verbatim from `stream.py`), `POST /api/chat` request/response shapes, and a response/error table for the portfolio and watchlist endpoints (findings 5, 6, 9).
4. Fix the two small hygiene items already called out in §13 (`.gitignore`, `.env.example`) — cheap, and blocking for anyone who actually runs the quick start today.
