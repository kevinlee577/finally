# FinAlly E2E Test Report

**Run date:** 2026-08-05
**Suite:** `test/` — Playwright, 53 tests across 7 spec files
**Scope:** all seven Key Scenarios in `planning/PLAN.md` §12
**Author:** integration-tester (task #13)

---

## Result

**53 / 53 passing at commit `f2dccba`**, against an image built from a clean
working tree at that revision. Containerised run exits `0`.

```
git log --oneline -1        -> f2dccba Build the full FinAlly application via an agent team
git status --porcelain      -> (empty: tree matches the commit exactly)
docker compose -f test/docker-compose.test.yml build     -> image 01:02:37, newer than every source file
docker compose -f test/docker-compose.test.yml up \
  --abort-on-container-exit --exit-code-from playwright
...
playwright-1  | [sse] 31 events in 3.1s = 10.1/sec
playwright-1  |   53 passed (1.2m)
EXIT=0
```

This is the first run that can be pinned to a revision rather than to a
timestamp. An earlier 53/53 (from a `--no-cache` build, 9.9 events/sec) was
taken before `f2dccba`'s last four files landed — the frontend tsconfig split —
so it is superseded by the result above rather than being the baseline for the
commit.

Verified in both environments:

| Environment | Result |
|---|---|
| Compose stack at `f2dccba`, clean tree (§12's intended path) | 53/53 passed, 1.2m |
| Compose stack, from-scratch `--no-cache` image (pre-commit) | 53/53 passed, 1.1m |
| Host run against `uvicorn` + the real Next.js static export | 53/53 passed, 56.9s |

Both used a freshly seeded database, `LLM_MOCK=true`, `MARKET_TICK_SECONDS=0.1`,
`SNAPSHOT_INTERVAL_SECONDS=1`, and health-poll readiness — per §12's Determinism
& Test Hooks. `retries` is `0`, so these are first-attempt passes with no flake
masking.

### Image provenance

An earlier 49/49 run was challenged on the grounds that it might have tested a
cached image predating recent fixes. Establishing what actually happened took
some care, and the distinction is worth recording precisely:

- The **backend** was current in that run — `stream.py` was modified at 22:28,
  the image was built at 23:54.
- The **frontend** was current *at the moment of the run*, then changed
  underneath it: frontend-engineer edited components at 00:07–00:14, after the
  image was built.

**This was chronology, not cache staleness.** Docker invalidates a `COPY` layer
on content change, so no stale layer was silently reused; the result simply
described a tree that no longer existed by the time it was read. Calling it a
caching problem — as an earlier draft of this report did — was imprecise, and
the difference matters: a caching bug would need a tooling fix, whereas this
needs only a habit.

For most of this cycle nothing was committed, so image contents could not be
pinned to a revision and "is this result current?" could not be answered from
git. The practice adopted instead was:

1. Rebuild.
2. Verify every source file under `frontend/` and `backend/` is older than the
   image timestamp.
3. Only then treat the run as describing current code.

`f2dccba` now makes this cheaper and stronger. The headline result was taken
with `git status --porcelain` empty, so the image was built from a tree
identical to the commit — the run describes a revision, not a moment in time.

**A green suite against an out-of-date image is worse than a red one**: it
actively asserts something false. The check that matters is unchanged — confirm
the tree is clean and the image postdates it — and it is worth repeating for any
future claim, because a commit only helps if the image was actually built from
it.

### Scenario coverage

| §12 Key Scenario | Spec file | Tests |
|---|---|---|
| Fresh start: watchlist, $10k, streaming | `01-fresh-start.spec.ts` | 7 |
| Add and remove a watchlist ticker | `02-watchlist.spec.ts` | 8 |
| Buy shares | `03-buy.spec.ts` | 7 |
| Sell shares | `04-sell.spec.ts` | 5 |
| Heatmap colours + P&L chart data | `05-visualisations.spec.ts` | 6 |
| AI chat (mocked) | `06-chat.spec.ts` | 10 |
| SSE disconnect, reconnect, recovery | `07-sse-resilience.spec.ts` | 10 |

---

## Resolved during this cycle

### `MARKET_TICK_SECONDS` was only half-wired — **fixed and verified**

**Owner:** database-engineer · **Status: RESOLVED**

Originally raised because `app/config.py` read the variable and `main.py` passed
it to the simulator, but the SSE emit loop kept a hardcoded
`interval: float = 0.5` that `create_stream_router` never accepted or forwarded.
Net effect: the cache bumped ~10×/sec while clients still received ~2 events/sec,
because the emitted rate is the *slower* of producer tick and stream poll.

**Provenance of the original "~2 events/sec" figure:** it was *derived by reading
the code* (a hardcoded 0.5s poll can emit at most 2/sec), not measured over the
wire. That distinction matters and was not clear in the first version of this
report. The suite now measures the rate directly instead of inferring it — see
"the stream honours MARKET_TICK_SECONDS end to end" in
`07-sse-resilience.spec.ts`, added specifically so this claim rests on evidence
rather than a code read.

Fix verified in the tree:

- `backend/app/market/stream.py:17` — `DEFAULT_STREAM_INTERVAL = 0.5` extracted
- `backend/app/market/stream.py:20` — `create_stream_router(price_cache, interval: float | None = None)`
- `backend/app/market/stream.py:48` — forwards `interval=poll_interval` into `_generate_events`
- `backend/app/main.py:108` — `create_stream_router(state.price_cache, interval=config.market_tick_seconds())`
- `backend/tests/test_stream_wiring.py` — added by database-engineer, including a
  case that drives the cache at 0.02s and asserts multiple events reach the
  consumer (fails against the old hardcoded 0.5s)

**Measured confirmation.** Against the current working tree with
`MARKET_TICK_SECONDS=0.1`, counting `data:` frames off `/api/stream/prices` over
a 5-second window:

```
MEASURED: 47 data frames in 5.0s = 9.4 events/sec
```

This matches database-engineer's independent in-process measurement (9.2/sec)
and is far above the 2/sec ceiling the old hardcoded path imposed. The fix is
confirmed empirically, not just by reading the diff.

A permanent regression test now enforces it from the outside — "the stream
honours MARKET_TICK_SECONDS end to end" in `07-sse-resilience.spec.ts` counts
events over a 3s window and asserts >4/sec. It complements
`backend/tests/test_stream_wiring.py` at a different layer: the unit test proves
the generator honours its parameter, the E2E test proves the configured value
actually reaches a browser through the real container and its environment. A
regression in either the wiring or the env plumbing is caught by one of them.

### A test-only type error could fail the production image build — **fixed and verified**

**Owner:** frontend-engineer · **Status: RESOLVED**

Surfaced while chasing image provenance: `frontend/tsconfig.json` included
`**/*.tsx` with no exclusion for `__tests__/`, and `next build` runs `tsc` over
whatever that config covers. A type error in a test file — code that never
ships — therefore failed `npm run build`, which failed the Docker image build.
frontend-engineer reproduced it deliberately before changing anything, and
confirmed a planted error in `__tests__/format.test.ts` broke `next build`.

Compounding it, a stale `tsconfig.tsbuildinfo` could let a local
`npm run typecheck` pass while a clean container build failed — the local-green
/ container-red asymmetry that is hardest to diagnose.

**Fix:** split configs. `tsconfig.json` (what `next build` uses) excludes
`__tests__`, `vitest.setup.ts` and `vitest.config.mts`; a new
`tsconfig.test.json` extends it and re-includes them with the vitest globals.
`npm run typecheck` runs both, and both run with `incremental: false` so neither
can pass off a stale build-info file.

Independently verified here, since the obvious risk in this shape of fix is
buying build stability by quietly dropping test type-safety:

```
tsc -p tsconfig.test.json --listFiles | grep -c __tests__   -> 13
tsc -p tsconfig.json      --listFiles | grep -c __tests__   ->  0
```

Test files are still fully type-checked against real app types; they are simply
no longer in the production build's path. frontend-engineer also verified the
fix in both directions with a planted error (build succeeds, typecheck fails
with exit code 2) rather than only confirming the happy path — checking the exit
code specifically, since a script that prints an error and exits 0 leaves CI
silently green.

---

## Open issues

**None.** No product defects are outstanding.

---

## Harness issues found and fixed

These were bugs in the test infrastructure, not the product. Each is recorded
because it initially *looked* like a product defect, and two would have produced
a false bug report against another engineer.

### A. `setOffline()` does not disconnect an established SSE stream

The obvious way to test §12's reconnection scenario is
`BrowserContext.setOffline(true)`. **It does not work**, and it fails in the worst
possible way: the test passes while testing nothing.

Measured with an instrumented `EventSource` across an offline window:

```
before offline  {"events":19,"opens":1,"errors":0,"rs":1}
during offline  {"events":46,"opens":1,"errors":0,"rs":1}   <-- 27 events arrived while "offline"
after  online   {"events":64,"opens":1,"errors":0,"rs":1}
```

`readyState` stayed `1` (OPEN), zero error events fired, and price events kept
flowing. Chromium's offline switch affects *new* requests; it does not tear down
a response already streaming. `route.abort()` has the same limitation from the
other direction — once the body has begun there is no request left to abort.

**Fix:** `test/e2e/control-proxy.ts`, a small in-process HTTP proxy the browser
talks to, which can destroy live sockets and refuse new connections on demand —
§12's "proxy in front of the app container that can be told to drop the
connection". The spec now also asserts the client observed an error *before*
asserting recovery, so this scenario can never silently become vacuous again.

frontend-engineer notes their unit tests dodged this only by driving a fake
`EventSource` directly, never touching the browser's network layer — so until
this fix, no layer was genuinely exercising a disconnect.

**With a real disconnect, the app's reconnection behaviour is correct.**

### B. A garbage-collected `EventSource` looks exactly like a reconnect bug

The independent SSE probe originally created its `EventSource` without retaining
a reference. Once the connection drops the object becomes eligible for garbage
collection and never performs its automatic retry — indistinguishable from the
app failing to reconnect. Fixed by storing the source on the probe object.

### C. Chromium force-upgrades `http://app:8000` to HTTPS

The compose service was initially named `app`. Chromium ships `app` in its **HSTS
preload list**, so every `page.goto()` failed with
`net::ERR_SSL_PROTOCOL_ERROR at http://app:8000/` — 17 of the 45 tests then in
the suite. API calls
bypass the browser and kept passing, which made it a confusing split failure.

**Fix:** the service is now `finally-app`. Do not rename it back.

### D. Mock-fixture trigger phrases are exact-substring and easy to get wrong

`backend/app/llm/mock.py` matches triggers by substring, first-match-wins, in
table order. A guessed phrase of `"buy 100000 aapl"` matches **neither**
`"buy 1000000 aapl"` nor `"buy 10 aapl"` (the characters after `buy 10` are
`0000 aapl`, not ` aapl`), so it falls through to the no-action default fixture
and the test asserts against a turn that executed nothing.

`test/e2e/mock-fixtures.ts` now mirrors the backend table exactly and exports
named constants; specs never retype a phrase. llm-engineer confirmed the phrases
are stable and pinned by `backend/tests/llm/test_mock.py`.

### E. The heatmap-colour assertion was comparing two different instants

The colour rule was checked by comparing the tile's `data-pnl-sign` against
`unrealized_pnl` from a separately fetched `GET /api/portfolio`. Those are two
observations of a continuously moving quantity taken at different moments, so a
position hovering near break-even legitimately disagrees. It failed
intermittently with API P&L `0.06` against a tile signed `zero`.

The first mitigation — only assert strictly when `|pnl| > 0.01` — was the wrong
shape. It shrank the failure window instead of removing it, and a single price
tick can move P&L by more than a cent, so it was guaranteed to resurface.

**Fix:** assert the sign against the tile's **own** `data-value` (the P&L it
rendered). Both attributes come from the same render, so the §12 colour rule is
now checked exactly, with no race. The API figure is still cross-checked, but
loosely and for a different purpose — proving the tile tracks live data rather
than a stub. Verified stable across repeated runs.

The general lesson: when asserting a relationship between two values, read both
from the same observation. Comparing a UI value to an independently fetched API
value is only sound for quantities that hold still.

### F. The E2E stack collided with the dev container on port 8000

`docker compose up` failed outright with `Bind for 0.0.0.0:8000 failed: port is
already allocated` when the container from `scripts/start_*` was running.

**Fix:** the compose file now publishes `${E2E_HOST_PORT:-8001}:8000`. The
Playwright container always reaches the app at `http://finally-app:8000` over the
compose network, so the host port is a convenience only, and the E2E suite can
now run alongside a running dev container (verified).

---

## Coverage added after teammate review

Two gaps closed on the strength of feedback from frontend-engineer:

**The red `disconnected` state is now covered.** §2 specifies a three-state
indicator, but a dropped socket can only ever produce amber — native EventSource
retries indefinitely and stays at CONNECTING, so `usePriceStream` maps it to
`reconnecting`. Red requires a *fatal* error setting `readyState` to CLOSED. The
control proxy gained a `setStreamFault` mode that makes `/api/stream/prices`
answer with a 503, or with a 200 carrying the wrong `Content-Type` (the failure a
misconfigured proxy or CDN would actually produce). Both are covered, and both
correctly produce `disconnected`. The specs also confirm recovery requires a
reload, since EventSource does not retry after a fatal error.

**UI-side §8 error codes are now asserted.** The suite previously checked error
codes only at the API. It now also drives a failing buy and a duplicate watchlist
add through the UI and asserts `trade-error` / `watchlist-error` carry
`data-error-code` of `insufficient_cash` and `duplicate_ticker` respectively,
plus that the rejected trade left cash untouched and the duplicate add left
exactly one row.

**Manual reconnect is covered.** frontend-engineer raised that the suite was
about to *pin* an inherited default — "recovery requires a reload" fell out of
native EventSource semantics rather than a decision, and a test blessing it would
have frozen it. They escalated for a scope call instead of quietly changing it;
the user approved adding a manual Reconnect control. Four tests now cover it:

- The control is absent from the DOM while `connected`, **and** while
  `reconnecting` — it must not race the browser's own retry.
- Clicking it against a still-broken endpoint settles back to `disconnected` and
  keeps the control available. This is the one most worth having: a naive
  implementation flips to `connected` on the optimistic state change and stays
  there, reporting a false green over a dead feed.
- Clicking it against a healthy endpoint restores the feed without a reload, the
  control disappears, **and prices resume ticking** — asserted on
  `watchlist-price-AAPL[data-value]` changing, because the indicator alone could
  go green over a stream that never delivers.
- Clearing the fault *without* clicking still leaves the feed down, which is the
  half of the original assertion that pins real behaviour. There is deliberately
  no auto-retry: silent retries against a genuinely misconfigured endpoint would
  hammer it and hide the fault behind an amber indicator.

The original assertion's wording — "a reload is required" — is now "a reload or
an explicit reconnect is required".

---

## Notes for other agents

**database-engineer** — Backend API contracts pass in full: the §8 error envelope
and every code the suite exercises (`invalid_ticker`, `duplicate_ticker`,
`not_watchlisted`, `no_position`, `insufficient_cash`, `insufficient_shares`,
`validation_error`, `quote_unavailable`), §8's formula invariants
(`market_value`, `unrealized_pnl`, `total_value`), §7 atomicity on rejected
trades, full-close row deletion, RFC 3339 timestamps, ascending history ordering,
the per-trade snapshot, and §6's "held-but-unwatchlisted stays tracked,
unsubscribes on close" rule. The stream-interval fix is verified. Nothing
outstanding.

Per their guidance the suite deliberately does **not** wait for a ticker removal
to appear over SSE — `PriceCache.remove()` does not bump the version counter, so
removals are driven from the REST response (§6).

**llm-engineer** — Chat passes in full, including the paths easiest to get wrong:
the §9 asymmetry (HTTP 200, narration claiming success while
`actions[0].status == "failed"` with no `fill_price` and cash unmoved), §7's
mid-batch semantics (`executed / failed / executed`, all three attempted, no
third "skipped" state), §9 step 7 ordering (all trades before all watchlist
changes), and the malformed-output fallback degrading in-band as a 200 with
`actions: []`. The deliberately-failing and malformed fixtures are what made
those contracts coverable at all.

**frontend-engineer** — Every requested `data-testid` is present and working,
including the two that made otherwise-untestable scenarios assertable:
`data-pnl-sign` on heatmap tiles (§12's colour rule cannot be checked by reading
computed fill colours out of a treemap) and `data-value` on numeric elements
(removes all currency/locale parsing — including the deliberate U+2212 minus used
for tabular alignment). Also in use: `data-state` on the connection indicator,
`data-point-count` on the P&L chart (read as a lower bound, not matched exactly
against history length, per their note that it counts snapshots plus a trailing
live point), `data-role` / `data-status` on chat messages and actions, the
`positions-empty` / `heatmap-empty` placeholders, the `trade-error` /
`watchlist-error` pair with `data-error-code`, and `reconnect-button`.

Two of their judgement calls are load-bearing for the suite and worth recording:
escalating the reload-only behaviour for a scope call rather than letting a test
freeze an inherited default, and hiding the reconnect control during
`reconnecting` so it cannot race the browser's own retry.

**devops-engineer** — The production image builds and runs correctly under
compose; `DB_PATH`, `STATIC_DIR`, `LLM_MOCK`, `MARKET_TICK_SECONDS` and
`SNAPSHOT_INTERVAL_SECONDS` are all honoured as overrides, and the tmpfs-backed
`DB_PATH` gives a genuinely fresh database per run. Two things to preserve: the
compose service must not be named `app` (harness issue C), and the published host
port defaults to 8001 to avoid colliding with the dev container (issue E).

---

## Reproducing

```bash
# Containerised (intended path)
./test/run_e2e.sh            # macOS / Linux
./test/run_e2e.ps1           # Windows PowerShell

# Against an already-running app
cd test && npm install && npx playwright install chromium
BASE_URL=http://localhost:8000 npx playwright test
```

See `test/README.md` for the full set of design constraints — notably that
`workers: 1` is a correctness requirement (single-user app, one SQLite file, one
shared cash balance), and that `01-fresh-start.spec.ts` must run first and fails
with an explicit "suite precondition failed" message if the database is not
fresh, so a stale container is never misreported as a product bug.
