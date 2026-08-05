# FinAlly E2E Tests

Playwright end-to-end suite covering the seven Key Scenarios in `planning/PLAN.md` §12.

## Running the suite

### Containerised (the intended path)

From the repo root, with Docker running:

```bash
docker compose -f test/docker-compose.test.yml up --build \
  --abort-on-container-exit --exit-code-from playwright
docker compose -f test/docker-compose.test.yml down -v
```

Or use the wrappers, which do both steps and always tear down:

```bash
./test/run_e2e.sh          # macOS / Linux
./test/run_e2e.ps1         # Windows PowerShell
```

`docker-compose.test.yml` builds the production image from the repo-root
`Dockerfile` and runs it alongside `mcr.microsoft.com/playwright`, so browser
dependencies stay out of the production image (§12).

### Against an already-running app

```bash
cd test
npm install
npx playwright install chromium   # first run only
BASE_URL=http://localhost:8000 npx playwright test
```

Note the compose stack publishes the app on **host port 8001** by default, not
8000 — the dev container started by `scripts/start_*` binds 8000, and a
collision fails the whole stack with `port is already allocated`. Override with
`E2E_HOST_PORT` if you want a different one. Inside the stack the Playwright
container always reaches the app at `http://finally-app:8000`, so this only
affects host access.

## Test hooks (§12 "Determinism & Test Hooks")

The compose file sets these on the app container:

| Variable | Test value | Production default | Why |
|---|---|---|---|
| `LLM_MOCK` | `true` | `false` | Deterministic, free, offline chat responses |
| `OPENROUTER_API_KEY` | *(empty)* | real key | Proves `chat_enabled` follows `LLM_MOCK` alone (§5) |
| `MASSIVE_API_KEY` | *(empty)* | optional | Forces the built-in GBM simulator (§6) |
| `DB_PATH` | `/e2e-db/finally.db` on tmpfs | `/app/db/finally.db` | Fresh, isolated DB per run; never touches a developer's `db/finally.db` |
| `MARKET_TICK_SECONDS` | `0.1` | `0.5` | Prices move fast enough to assert on quickly |
| `SNAPSHOT_INTERVAL_SECONDS` | `1` | `30` | Snapshot task observable without a 30s wait |

Readiness is gated twice: the compose healthcheck polls `GET /api/health`, and
`global-setup.ts` polls it again so the suite is equally safe when run from the
host (§12 "Readiness" — poll, never a fixed sleep).

## Design notes

**Serial execution is required, not a preference.** FinAlly is single-user: one
SQLite file, one hardcoded `user_id`, one shared cash balance and watchlist
(§7). `playwright.config.ts` pins `workers: 1` and `fullyParallel: false`.
Running in parallel would have workers trading against each other's cash,
producing failures that look like product bugs but are harness bugs.

**Spec files are numbered and order-dependent.** `01-fresh-start.spec.ts`
asserts the untouched seed state ($10,000 cash, no positions) and so must run
before any trading spec. Its first test fails with an explicit
"suite precondition failed" message if the database is not fresh, so a stale
container is never misreported as a product bug. Every later spec uses
delta-based assertions (read state, act, compare) rather than absolute values.

**No retries.** `retries: 0` is deliberate. The deliverable is a findings
report (`planning/E2E_REPORT.md`); passing on a second attempt would hide
exactly the intermittent races most worth reporting. A flake here is a finding.

**Specs assert against both the UI and the REST API.** This is what lets the
report attribute a failure to an owner: if the API is correct but the UI
disagrees, it is a frontend bug; if the API itself is wrong, it is a backend
bug. The buy/sell specs read `GET /api/portfolio` alongside every UI
assertion for exactly this reason.

**The SSE spec cuts the connection with a proxy, not with `setOffline`.**
`e2e/control-proxy.ts` is a small in-process HTTP proxy the browser talks to,
which can destroy live sockets on demand — §12's "proxy in front of the app
container that can be told to drop the connection". This is not
over-engineering: `BrowserContext.setOffline(true)` was measured and does *not*
tear down an already-established SSE stream (readyState stayed OPEN, zero error
events, price events kept arriving throughout the "offline" window), and
`route.abort()` cannot touch a response that has already begun streaming. A
reconnection test built on either mechanism passes without ever disconnecting
anything. The spec therefore also asserts that the client observed an error
before asserting recovery, so the scenario can never silently become vacuous.

**The SSE spec uses its own EventSource probe.** `helpers.installSseProbe`
opens a stream independent of the app's client code, so a reconnection failure
can be attributed to either the stream endpoint or the frontend's EventSource
handling rather than being ambiguous. §12 notes EventSource retry is
client-side and unobservable from outside the browser, which is why this runs
in-page. The probe keeps a reference to its `EventSource` — without one the
object is garbage-collected after its connection drops and never retries,
which looks exactly like a product bug.

**The app service is named `finally-app`, not `app`.** Chromium ships `app` in
its HSTS preload list, so `http://app:8000` gets force-upgraded to HTTPS and
every `page.goto()` fails with `ERR_SSL_PROTOCOL_ERROR`. API calls bypass the
browser and keep working, which makes it a confusing failure to diagnose.
Don't rename it back.

## Files

| File | Purpose |
|---|---|
| `docker-compose.test.yml` | App container + Playwright container (§12) |
| `playwright.config.ts` | Serial execution, reporters, timeouts |
| `global-setup.ts` | Health-poll readiness gate |
| `e2e/helpers.ts` | Selectors, numeric parsing, API clients, SSE helpers |
| `e2e/mock-fixtures.ts` | Mirrors `backend/app/llm/mock.py` trigger table |
| `e2e/control-proxy.ts` | Controllable proxy used to sever the SSE connection |
| `e2e/0*.spec.ts` | One file per §12 Key Scenario |

### Keeping fixtures in sync

`e2e/mock-fixtures.ts` mirrors `MOCK_FIXTURES` in `backend/app/llm/mock.py`.
Matching is **substring, first-match-wins, in table order**, so exact trigger
text is load-bearing — `"buy 100000 aapl"` does not match the
`"buy 1000000 aapl"` fixture and would silently fall through to the no-action
default. Always use the exported constants rather than retyping phrases.
