# FinAlly Plan Review (Codex)

## Overall assessment

The plan is directionally strong, and its SSE format now matches the shipped market-data implementation. However, it is not yet safe as a shared implementation contract: core REST payloads and portfolio formulas remain undefined, the repaired ticker lifecycle omits restart behavior, and the repaired chat contract contradicts itself on skipped actions and post-execution messaging. The repository is also much less complete than the directory tree and quick-start instructions imply. Notably, `planning/REVIEW.md` is absent from the current working tree, so the requested comparison to that file could not be performed directly; the open items named in the review request were independently checked below.

## Findings ranked by priority

### High

#### H1. ~~Held-but-unwatchlisted tickers are lost from market tracking after a restart~~ **Resolved (2026-08-02, §6 "Ticker Tracking Set"):**

- **What's wrong:** Section 6 defines correct removal and position-close behavior during a running process, but never says what ticker set is passed to `MarketDataSource.start()` at application startup. It also describes Massive as polling watched tickers only. A held ticker removed from the watchlist will therefore cease receiving quotes after restart if an agent initializes the source from the watchlist table alone.
- **Where:** `planning/PLAN.md` lines 160-163 and 186-188; shipped lifecycle API in `backend/app/market/interface.py` lines 15-30.
- **Why it matters:** Portfolio values, P&L, and sell fills can become permanently stale or unavailable even though the position remains open. Independent database and market agents can both follow the current text and still produce this bug.
- **Suggested fix:** State that startup tracking is the normalized set union of watchlist tickers and tickers with `positions.quantity > 0`; keep that invariant after every watchlist mutation and trade. Replace “union of all watched tickers” with “union of watchlisted and held tickers.”

#### H2. ~~The REST API still has no implementable response schemas or portfolio formulas~~ **Resolved (2026-08-02, §7 "Portfolio Snapshot Semantics" / §8 "Portfolio Metric Formulas" & "Response Examples"):**

- **What's wrong:** The endpoint table and “affected resource(s) directly” convention do not define exact JSON keys, nesting, nullability, timestamp format, empty-list behavior, DELETE status/body, or response bodies for any portfolio/history/watchlist/health operation. “Total value,” “unrealized P&L,” “% change,” “weight,” and history are not mathematically defined. It is also unclear whether cash is included in heatmap weights and what happens when a held ticker has no quote.
- **Where:** `planning/PLAN.md` lines 265-313 and 416-423.
- **Why it matters:** Frontend and backend agents can create mutually incompatible payloads and calculate visibly different totals while each satisfies the prose.
- **Suggested fix:** Add canonical request/response examples or JSON Schema/OpenAPI models for every endpoint. Define at least `market_value = quantity * current_price`, position unrealized P&L and percent return, `total_value = cash + sum(market_value)`, aggregate unrealized P&L, position weight denominator, rounding/display rules, quote-null behavior, history ordering/range, and DELETE semantics.

#### H3. The revised chat execution contract is internally contradictory

**Partially resolved (2026-08-01):** The two contradictions called out here are fixed in `planning/PLAN.md`. §7's "Transactions & Concurrency" no longer has a `skipped` status or batch-abort-on-first-failure behavior — every trade in a batch is now explicitly attempted regardless of earlier failures, so the model only ever needs `executed | failed`, matching §9's envelope. §9's worked example message was rewritten to be pre-execution/noncommittal ("On it — buying 10 AAPL, buying 5 TSLA, and adding PYPL to your watchlist.") instead of narrating outcomes it couldn't know yet, with an explicit note that `message` describes intent, not actual results.

**Also resolved (2026-08-02, §9 "How It Works" step 7):** watchlist-changes ordering is now defined — all `trades` execute first (in array order), then all `watchlist_changes` (in array order); a failure anywhere does not block or skip later entries in either array.

- **What's wrong:** Section 7 requires later trades to be reported as `skipped` after a batch failure, but the response envelope permits only `executed | failed` and says there is one action “in the order attempted”; skipped trades are not attempted. Watchlist changes have no specified ordering relative to trades or failure policy. The example message describes actual fills/failures, while lines 356, 365, and 382 say the LLM wrote the message before execution and it is returned unmodified, so that example cannot be produced under the stated flow.
- **Where:** `planning/PLAN.md` lines 257-259 and 336-385.
- **Why it matters:** Backend, frontend, persistence, and tests will disagree on legal statuses and what the user actually sees after partial execution.
- **Suggested fix:** Define `status` as `executed | failed | skipped`, require an entry for every proposal, define a single global action ordering and whether a trade failure affects later watchlist actions, and either (a) make the example message pre-execution/noncommittal, or (b) explicitly add a server-generated execution summary separate from the unmodified LLM message.

#### H4. ~~The tradeable-symbol and tracking contract is undefined~~ **Resolved (2026-08-02, §6 "Tradeable Symbols", §8 error table):**

- **What's wrong:** The trade bar accepts a ticker, but the plan does not say whether a trade is allowed only for watchlisted/held symbols, whether the backend calls `add_ticker()` for a new trade symbol, or how a symbol is validated. `unknown_ticker` is described as a missing position/watchlist row, which makes a first buy of an otherwise valid unwatchlisted ticker look invalid. Conversely, the simulator assigns a random price to any string, while Massive may never return a quote.
- **Where:** `planning/PLAN.md` lines 269-279, 292-303, and 421; `backend/app/market/simulator.py` lines 146-152; `backend/app/market/massive_client.py` lines 66-70.
- **Why it matters:** Manual and AI trades can behave differently by provider, and a backend agent cannot determine whether to reject, subscribe, or wait for a ticker.
- **Suggested fix:** Define ticker syntax and authoritative validity policy, state the permitted trade universe, and specify subscription timing. If arbitrary valid tickers are tradable, add tracking first and return `quote_unavailable` until quoted; distinguish `invalid_ticker`, `not_watchlisted`, and `no_position` rather than overloading `unknown_ticker`.

### Medium

#### M1. ~~Transaction isolation is not strong enough as specified~~ **Resolved (2026-08-02, §7 "Transactions & Concurrency"):**

- **What's wrong:** A single in-process async lock protects only one process and does not itself establish SQLite write-lock timing. No single-worker deployment requirement, transaction mode (`BEGIN IMMEDIATE`), busy timeout, or retry behavior is stated. The text also says “all four writes,” although position deletion on a full sell and the cash update/position update/trade/snapshot operations are not uniformly four inserts/writes.
- **Where:** `planning/PLAN.md` lines 255-259 and Docker command description at lines 444-450.
- **Why it matters:** Multiple Uvicorn workers, duplicate app instances, or future test topology can reintroduce overspending and lock errors despite an implementation claiming compliance.
- **Suggested fix:** Require one server process/worker and define the SQLite transaction mode plus busy timeout, or make DB locking the source of truth. Describe the atomic state changes rather than “all four writes.”

#### M2. ~~Database initialization timing still conflicts~~ **Resolved (2026-08-02, §4/§7/README):**

- **What's wrong:** Section 4 says initialization is lazy on first request; Section 7 says startup “or first request.” Market startup needs seeded watchlist/position data, so this cannot safely remain optional.
- **Where:** `planning/PLAN.md` lines 110-113 and 192-200.
- **Why it matters:** Agents may initialize market data before the database exists, seed during a concurrent request, or expose health before required state is ready.
- **Suggested fix:** Choose one lifecycle. Prefer idempotent schema creation/seeding in the FastAPI lifespan before market-data startup, with readiness reported only afterward.

#### M3. ~~Portfolio snapshot semantics and retention are incomplete~~ **Resolved (2026-08-02, §7 "Portfolio Snapshot Semantics"):**

- **What's wrong:** The plan calls the graph a “P&L chart,” but stores only total value, does not define a baseline or P&L series, initial snapshot, ordering, retention/window, duplicate timestamps, behavior while quotes are unavailable, or whether the 30-second task runs immediately. It also ambiguously says the snapshot task is behind a lock intended for “ad hoc snapshot writes.”
- **Where:** `planning/PLAN.md` lines 236-240, 257-259, 294, and 419.
- **Why it matters:** Backend and chart agents can produce different meanings, and the database can grow without bound.
- **Suggested fix:** Specify initial/periodic/trade snapshot timing, valuation formula and missing-quote rule, UTC timestamp format, response order/window, retention, and whether the UI plots value or P&L relative to a defined baseline.

#### M4. ~~The persistence model for chat turns and failures is underspecified~~ **Resolved (2026-08-02, §9 "How It Works"):**

- **What's wrong:** The flow says “stores the message,” but does not explicitly require both user and assistant rows, define transaction boundaries, or say whether malformed-LLM and provider errors are persisted/returned as HTTP errors versus a successful generic assistant response. It says later turns see action outcomes, but does not define how `actions` JSON is injected into LLM history.
- **Where:** `planning/PLAN.md` lines 242-248 and 323-389.
- **Why it matters:** Conversation history can have missing turns, duplicate messages after retries, or omit the very execution results the model is expected to learn from.
- **Suggested fix:** Define the exact two-row persistence sequence, failure behavior and HTTP envelope, serialization of action outcomes into the next prompt, and atomicity/idempotency expectations.

#### M5. ~~Error conventions do not cover framework validation or all domain cases~~ **Resolved (2026-08-02, §8 "Response & Error Conventions"):**

- **What's wrong:** The plan promises the custom envelope for every non-2xx API response, but FastAPI emits 422 by default for request-model errors. There are no codes for missing watchlist membership versus missing position, invalid side, malformed chat output/provider failure, database conflict, or internal error. `unknown_ticker` combines unrelated cases.
- **Where:** `planning/PLAN.md` lines 265-282.
- **Why it matters:** A frontend written to the promised envelope will break on common validation failures.
- **Suggested fix:** Define exception handlers that translate framework 422s and unhandled errors into the envelope, and enumerate endpoint-specific status/code cases.

#### M6. ~~Cache removal is not immediately observable in the shipped SSE implementation~~ **Resolved (2026-08-02, §6, documented as eventually-consistent with REST driving immediate client removal):**

- **What's wrong:** The plan tells the frontend to replace its map from full snapshots and says removing a ticker evicts it from the stream. In the shipped cache, `remove()` does not increment `version`; the stream emits only on version changes. Removal therefore produces no event until some later price update (up to roughly 15 seconds in Massive mode, or indefinitely if no remaining ticker updates).
- **Where:** `planning/PLAN.md` lines 177-188; `backend/app/market/cache.py` lines 59-67; `backend/app/market/stream.py` lines 75-85.
- **Why it matters:** Removed symbols can linger in the frontend and tests can race.
- **Suggested fix:** Either change the market component later so removal increments the version, or explicitly make the REST mutation response drive immediate client removal and document SSE convergence latency. Add a removal-stream test.

#### M7. ~~Environment/key behavior contradicts the first-launch promise~~ **Resolved (2026-08-02, §5, plus `.env.example` created):**

- **What's wrong:** First launch promises an AI panel “ready to assist,” while `OPENROUTER_API_KEY` is required and no keyless non-test behavior is defined. Mock mode supports development, but the quick start asks users to add a key and the repository has no `.env.example`.
- **Where:** `planning/PLAN.md` lines 13-20, 120-139, and 401-406; `README.md` quick start and environment table.
- **Why it matters:** A fresh clone cannot follow the documented setup and may fail startup or chat unexpectedly.
- **Suggested fix:** Commit a placeholder `.env.example` and define whether missing OpenRouter credentials disable chat gracefully, automatically select mock mode, or fail startup; align the first-launch copy with that decision.

#### M8. ~~The repository layout is presented as current even though most entries do not exist~~ **Resolved (2026-08-02):** §4 now opens with an explicit "this is the target layout, not the current repo state" note; `planning/REVIEW.md` (this review's sibling) has been restored and is present again.

- **What's wrong:** There is currently no `frontend/`, `db/`, `scripts/`, `test/`, `Dockerfile`, or `.env.example`; only the market-data backend exists. The tree claims `db/.gitkeep` exists and `finally.db` is ignored. Neither is true. `planning/REVIEW.md`, which the review request identifies as existing, is also absent from both the filesystem and `git ls-files`.
- **Where:** `planning/PLAN.md` lines 85-116 and 521-540; root repository state.
- **Why it matters:** Agents may assume prerequisite scaffolding or review context is available and skip required work.
- **Suggested fix:** Label the tree explicitly as the target layout, add ownership/creation tasks for absent paths, restore or supply `planning/REVIEW.md` if it is intended to be shared, and avoid resolved-review notes inside the normative plan.

#### M9. ~~SQLite files and sidecars are not ignored~~ **Resolved (2026-08-02):**

- **What's wrong:** `.gitignore` contains only the boilerplate `db.sqlite3`/journal patterns, not `db/finally.db`, `db/finally.db-wal`, or `db/finally.db-shm`, despite the plan claiming the database is ignored.
- **Where:** `planning/PLAN.md` lines 101-105 and 527-528; `.gitignore` lines 53-55.
- **Why it matters:** Runtime data can be accidentally committed, including WAL contents.
- **Suggested fix:** Add explicit root-anchored patterns for the DB and its `-wal`, `-shm`, and optionally `-journal` sidecars before the DB layer lands.

#### M10. ~~Docker filesystem and environment contracts are ambiguous~~ **Resolved (2026-08-02, §11):**

- **What's wrong:** A named volume mounted at `/app/db` is described as if the host project-root `db/` maps there; named volumes do not map that host directory. The plan does not define the app working directory, database-path configuration, static output directory (`out/`), how the root `.env` reaches a build context centered on `backend/`, or whether `uv sync` installs dev dependencies.
- **Where:** `planning/PLAN.md` lines 67, 101-113, 139, and 435-463.
- **Why it matters:** Docker and backend agents can choose incompatible paths, and the promised single command may not boot.
- **Suggested fix:** Define an absolute/container DB path (preferably configurable), WORKDIR and copy layout, production `uv sync` flags, Next export source/destination, and distinguish named-volume persistence from a bind mount.

#### M11. ~~The named LLM skill does not match the repository skill~~ **Resolved (2026-08-02, §9):**

- **What's wrong:** The plan repeatedly requires `cerebras-inference`, but the tracked repository provides `.claude/skills/cerebras/SKILL.md` and no skill with the specified name.
- **Where:** `planning/PLAN.md` lines 319-330; `.claude/skills/cerebras/SKILL.md`.
- **Why it matters:** An implementation agent may fail to locate mandatory guidance or silently ignore it.
- **Suggested fix:** Use the actual skill name/path or add the intended skill under the stated name; keep runtime requirements in the specification independently of agent-specific tooling.

#### M12. ~~Deterministic E2E observability is not defined~~ **Resolved (2026-08-02, §12 "Determinism & Test Hooks"):**

- **What's wrong:** `LLM_MOCK=true` has no request-to-response fixtures, the simulator has no documented deterministic seed/control, the 30-second snapshot wait is long, and “disconnect and verify reconnection” has no mechanism to force or observe a disconnect. No stable readiness/reset endpoint or isolated DB strategy is specified.
- **Where:** `planning/PLAN.md` lines 401-406 and 487-518.
- **Why it matters:** Separate testing and implementation agents cannot build reliable tests for chat actions, SSE recovery, flashes, or chart snapshots.
- **Suggested fix:** Specify mock prompts/results, seeded/fake market controls, configurable snapshot/market intervals, a clean per-run database, readiness semantics, and a deliberate SSE disconnect/test hook or proxy procedure.

### Low

#### L1. ~~Timestamp formats are only partially specified~~ **Resolved (2026-08-02, §7/§8):**

- **What's wrong:** SSE uses Unix seconds, while database fields merely say “ISO timestamp”; timezone, precision, and UTC suffix are not fixed.
- **Where:** `planning/PLAN.md` lines 184 and 206-248.
- **Why it matters:** Sorting and frontend parsing can differ across agents/platforms.
- **Suggested fix:** Require UTC RFC 3339 strings (for example, `2026-08-01T22:15:30.123Z`) for REST/database timestamps and Unix seconds only for the shipped SSE model.

#### L2. ~~Money and quantity precision rules invite drift~~ **Resolved (2026-08-02, §7 "Money & Quantity Precision"):**

- **What's wrong:** Cash, costs, and quantities use SQLite `REAL`; prices are rounded to cents but cash/average cost/P&L rounding and maximum fractional precision are undefined. “No additional precision cap” permits pathological quantities.
- **Where:** `planning/PLAN.md` lines 206-240 and 281.
- **Why it matters:** Repeated fractional trades can produce floating-point residue and inconsistent zero-position detection.
- **Suggested fix:** Define decimal/integer-minor-unit arithmetic and quantization, a quantity precision/maximum, and an exact rule for closing/deleting positions.

#### L3. ~~Health and static-route behavior are unspecified~~ **Resolved (2026-08-02, §8/§11):**

- **What's wrong:** `/api/health` has no payload or liveness/readiness meaning, and static serving does not say how `/`, assets, unknown API paths, and SPA-style routes are ordered/fallbacked.
- **Where:** `planning/PLAN.md` lines 48-70, 310-313, and 453.
- **Why it matters:** Docker health checks and route mounting can report healthy too early or swallow API 404s.
- **Suggested fix:** Define the health JSON/status dependencies and route precedence, with API 404s never falling through to the frontend.

#### L4. ~~Root documentation already disagrees with the plan on initialization~~ **Resolved (2026-08-02, README.md updated to match §7):**

- **What's wrong:** `README.md` calls SQLite initialization lazy, while the plan permits startup or first request.
- **Where:** `README.md` Architecture section; `planning/PLAN.md` lines 112 and 194-200.
- **Why it matters:** It reinforces the unresolved lifecycle ambiguity for implementers.
- **Suggested fix:** After choosing the initialization lifecycle, update both documents to the same wording.

## Recommended next steps

1. Resolve H1-H4 in `PLAN.md`, especially startup ticker reconciliation, complete REST schemas/formulas, and one coherent chat action state machine.
2. Add a compact canonical API appendix (examples plus error matrix) and explicit database/application lifecycle rules.
3. Align the target repository/Docker/env contract, add `.env.example` and database ignore patterns, and restore `planning/REVIEW.md` if it is meant to remain shared context.
4. Define deterministic test controls, then add contract tests spanning market cache/SSE, portfolio/watchlist lifecycle, chat partial failures, and frontend-consumed payloads.
