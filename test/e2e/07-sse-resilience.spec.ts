import { expect, test } from '@playwright/test';
import { startControlProxy, type ControlProxy } from './control-proxy';
import {
  installSseProbe,
  readConnectionState,
  readSseProbe,
  readWatchlistPrice,
  sel,
  waitForPriceChange,
  waitForSseEvents,
} from './helpers';

/**
 * PLAN.md §12 scenario 7 — "SSE resilience: disconnect and verify
 * reconnection".
 *
 * Two mechanisms are combined:
 *
 * 1. A controllable proxy (./control-proxy.ts) that genuinely severs the live
 *    TCP connection. See that file for why neither `route.abort()` nor
 *    `setOffline()` can do this — both leave an established SSE stream running,
 *    which would make this scenario silently vacuous.
 *
 * 2. An independent in-page EventSource probe (helpers.installSseProbe),
 *    separate from the app's own client. That separation is what makes a
 *    failure attributable: if the probe recovers but the app's prices and
 *    indicator do not, the bug is in the frontend's EventSource handling; if
 *    neither recovers, the stream endpoint itself is at fault.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8000';

test.describe('SSE resilience', () => {
  let proxy: ControlProxy;

  test.beforeEach(async () => {
    proxy = await startControlProxy(BASE_URL);
  });

  test.afterEach(async () => {
    await proxy.close();
  });

  test('the stream sends the retry directive and well-formed price events', async ({ page }) => {
    await page.goto('/');

    // Read the raw stream inside the browser and abort after the first data
    // frame. A normal request helper cannot be used here: the endpoint is
    // long-lived and never completes, so awaiting a full body would time out
    // rather than returning the payload.
    const raw = await page.evaluate(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch('/api/stream/prices', { signal: controller.signal });
        const contentType = res.headers.get('content-type') ?? '';
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';

        while (!text.includes('data:') || !text.includes('\n\n')) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.length > 200_000) break;
        }

        await reader.cancel();
        return { status: res.status, contentType, text };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    });

    expect(raw.status).toBe(200);
    expect(raw.contentType, 'SSE endpoint must serve text/event-stream').toContain(
      'text/event-stream',
    );
    expect(raw.text, 'server sends a `retry: 1000` directive on connect (§6)').toContain('retry:');

    const dataLine = raw.text.split('\n').find((line) => line.startsWith('data:'));
    expect(dataLine, 'expected a data: line in the stream (§6)').toBeDefined();

    // §6: each event's data line is a JSON object keyed by ticker, carrying a
    // full snapshot rather than a diff.
    const payload = JSON.parse(dataLine!.slice('data:'.length).trim()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(typeof payload, 'SSE payload is a JSON object keyed by ticker (§6)').toBe('object');

    const entries = Object.values(payload);
    expect(entries.length, 'snapshot should contain the tracked tickers').toBeGreaterThan(0);

    const first = entries[0];
    for (const field of [
      'ticker',
      'price',
      'previous_price',
      'timestamp',
      'change',
      'change_percent',
      'direction',
    ]) {
      expect(first, `PriceUpdate.to_dict() must include "${field}" (§6)`).toHaveProperty(field);
    }
    expect(['up', 'down', 'flat'], 'direction is up/down/flat (§6)').toContain(first.direction);
    expect(
      typeof first.timestamp,
      'SSE timestamps are Unix seconds, not RFC 3339 strings (§6 vs §8)',
    ).toBe('number');
  });

  test('the stream honours MARKET_TICK_SECONDS end to end', async ({ page }) => {
    // Regression guard for the half-wired-interval bug: `MARKET_TICK_SECONDS`
    // reached the simulator but not the SSE emit loop, which kept a hardcoded
    // 0.5s poll. Because the delivered rate is the *slower* of producer tick and
    // stream poll, the wire stayed at ~2 events/sec no matter how the variable
    // was set. That was originally caught by reading the code; this measures it.
    //
    // PRECONDITION: the §12 fast-interval override, MARKET_TICK_SECONDS=0.1,
    // which docker-compose.test.yml sets. At 0.1 the observed rate is ~10/sec;
    // the old hardcoded path could not exceed 2/sec. The 4/sec threshold sits
    // clearly above that ceiling and well below the real rate, so it separates
    // the two without being timing-sensitive.
    await page.goto('/');
    await installSseProbe(page);
    await waitForSseEvents(page, 1);

    const started = await readSseProbe(page);
    const t0 = Date.now();
    await page.waitForTimeout(3_000);
    const ended = await readSseProbe(page);

    const elapsedSeconds = (Date.now() - t0) / 1000;
    const rate = (ended.events - started.events) / elapsedSeconds;
    console.log(
      `[sse] ${ended.events - started.events} events in ${elapsedSeconds.toFixed(1)}s ` +
        `= ${rate.toFixed(1)}/sec`,
    );

    expect(
      rate,
      `SSE delivered ${rate.toFixed(1)} events/sec. At MARKET_TICK_SECONDS=0.1 this ` +
        'should be ~10/sec. A value at or below ~2/sec means the stream poll interval ' +
        'is ignoring the setting (or the image predates the fix).',
    ).toBeGreaterThan(4);
  });

  test('EventSource reconnects after the connection is severed', async ({ page }) => {
    // Everything, including the page itself, goes through the proxy so the
    // stream is same-origin and can be cut at the socket.
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();

    await installSseProbe(page);
    await waitForSseEvents(page, 2);

    const beforeDrop = await readSseProbe(page);
    expect(beforeDrop.opens, 'probe should have opened the stream once').toBeGreaterThanOrEqual(1);

    // Sever the live connection and keep retries failing for a couple of
    // seconds, so the retry path is genuinely exercised rather than the
    // connection simply never breaking.
    proxy.setRejecting(true);
    proxy.dropAll();
    await page.waitForTimeout(2_000);

    // The drop must actually register as an error on the client. If this stays
    // at 0 the disconnect never happened and the rest of the test is vacuous.
    await expect
      .poll(async () => (await readSseProbe(page)).errors, {
        message:
          'severing the connection should surface an error on the client; 0 errors ' +
          'means nothing was actually disconnected',
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    proxy.setRejecting(false);

    // Once connections succeed again, EventSource must re-establish on its own.
    await expect
      .poll(async () => (await readSseProbe(page)).opens, {
        message:
          'EventSource should re-open the stream once connections succeed again ' +
          '(§6 "Client handles reconnection automatically").',
        timeout: 30_000,
      })
      .toBeGreaterThan(beforeDrop.opens);

    // ...and resume delivering events, not just reconnect and sit idle.
    const resumed = (await readSseProbe(page)).events;
    await waitForSseEvents(page, resumed + 2, 30_000);
  });

  test('the app resumes live prices and a connected indicator after a drop', async ({ page }) => {
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await waitForPriceChange(page, 'AAPL');

    proxy.setRejecting(true);
    proxy.dropAll();

    // §2/§10: the indicator must reflect the broken feed.
    await expect
      .poll(() => readConnectionState(page), {
        message:
          'the connection indicator should leave "connected" while the feed is down ' +
          '(§2 Visual Design / §10 Header)',
        timeout: 15_000,
      })
      .not.toBe('connected');

    proxy.setRejecting(false);

    await expect
      .poll(() => readConnectionState(page), {
        message:
          'connection indicator should return to "connected" once the feed recovers. ' +
          'If prices resume but this stays wrong, the indicator wiring is the bug, ' +
          'not the stream.',
        timeout: 30_000,
      })
      .toBe('connected');

    // Prices must actually resume moving, not just show a green dot.
    await waitForPriceChange(page, 'AAPL', 30_000);
  });

  test('a fatal stream error shows "disconnected", not "reconnecting"', async ({ page }) => {
    // The three-state indicator (§2 Visual Design) needs all three states
    // covered. A dropped socket can only ever produce amber: native EventSource
    // retries indefinitely and stays at CONNECTING. Red requires a *fatal*
    // error that sets readyState to CLOSED, which is what this fault injects.
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await expect.poll(() => readConnectionState(page), { timeout: 20_000 }).toBe('connected');

    // Make the stream endpoint answer fatally, then cut the live connection so
    // the client retries into the fault.
    proxy.setStreamFault('status');
    proxy.dropAll();

    await expect
      .poll(() => readConnectionState(page), {
        message:
          'a non-200 from /api/stream/prices is fatal to EventSource (readyState ' +
          'CLOSED), so the indicator should show "disconnected" (red), not ' +
          '"reconnecting" (amber)',
        timeout: 30_000,
      })
      .toBe('disconnected');

    // The manual control is offered only in this state (see the dedicated
    // reconnect tests below).
    await expect(
      page.getByTestId(sel.reconnectButton),
      'the manual reconnect control should be offered once the feed has given up',
    ).toBeVisible();

    // There is deliberately no auto-retry after a fatal error, so clearing the
    // fault alone must not resurrect the feed — recovery takes a reload or an
    // explicit reconnect.
    proxy.setStreamFault('none');
    await page.waitForTimeout(3_000);
    expect(
      await readConnectionState(page),
      'clearing the fault alone must not silently reconnect — recovery is deliberately ' +
        'manual so a misconfigured endpoint is not hammered by silent retries',
    ).toBe('disconnected');

    await page.reload();

    await expect
      .poll(() => readConnectionState(page), {
        message: 'a reload should re-establish the feed once the fault is cleared',
        timeout: 30_000,
      })
      .toBe('connected');
    await waitForPriceChange(page, 'AAPL', 30_000);
  });

  test('the reconnect control is absent unless the feed has given up', async ({ page }) => {
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await expect.poll(() => readConnectionState(page), { timeout: 20_000 }).toBe('connected');

    // Absent from the DOM entirely while healthy, not merely hidden.
    await expect(
      page.getByTestId(sel.reconnectButton),
      'no reconnect control while connected',
    ).toHaveCount(0);

    // Also absent while amber: it must not race the browser's own retry.
    proxy.setRejecting(true);
    proxy.dropAll();

    await expect
      .poll(() => readConnectionState(page), { timeout: 20_000 })
      .toBe('reconnecting');
    await expect(
      page.getByTestId(sel.reconnectButton),
      'no reconnect control while the browser is still retrying on its own',
    ).toHaveCount(0);

    proxy.setRejecting(false);
    await expect.poll(() => readConnectionState(page), { timeout: 30_000 }).toBe('connected');
  });

  test('reconnecting into a still-broken feed does not produce a false green', async ({ page }) => {
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await expect.poll(() => readConnectionState(page), { timeout: 20_000 }).toBe('connected');

    proxy.setStreamFault('status');
    proxy.dropAll();
    await expect.poll(() => readConnectionState(page), { timeout: 30_000 }).toBe('disconnected');

    // Click while the fault is still active. A naive implementation flips to
    // connected on the optimistic state change and stays there; the indicator
    // must end up back at disconnected instead.
    await page.getByTestId(sel.reconnectButton).click();

    await expect
      .poll(() => readConnectionState(page), {
        message:
          'reconnecting into a still-broken endpoint must settle back to ' +
          '"disconnected", never report a false "connected"',
        timeout: 30_000,
      })
      .toBe('disconnected');

    await expect(
      page.getByTestId(sel.reconnectButton),
      'the control should remain available after a failed retry',
    ).toBeVisible();
  });

  test('an explicit reconnect recovers the feed without a reload', async ({ page }) => {
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await expect.poll(() => readConnectionState(page), { timeout: 20_000 }).toBe('connected');

    proxy.setStreamFault('status');
    proxy.dropAll();
    await expect.poll(() => readConnectionState(page), { timeout: 30_000 }).toBe('disconnected');

    // Prices are deliberately not cleared on disconnect — the last known values
    // stay on screen, stale but flagged by the red indicator.
    const stalePrice = await readWatchlistPrice(page, 'AAPL');
    expect(Number.isNaN(stalePrice), 'last known price should remain rendered while down')
      .toBe(false);

    proxy.setStreamFault('none');
    await page.getByTestId(sel.reconnectButton).click();

    await expect
      .poll(() => readConnectionState(page), {
        message: 'an explicit reconnect against a healthy endpoint should restore the feed',
        timeout: 30_000,
      })
      .toBe('connected');

    await expect(
      page.getByTestId(sel.reconnectButton),
      'the control should disappear once the feed is healthy again',
    ).toHaveCount(0);

    // The indicator alone could go green on a stream that never delivers, so
    // assert prices actually resume ticking.
    await waitForPriceChange(page, 'AAPL', 30_000);
  });

  test('a wrong Content-Type is also treated as a fatal stream error', async ({ page }) => {
    await page.goto(proxy.url);
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await expect.poll(() => readConnectionState(page), { timeout: 20_000 }).toBe('connected');

    // A 200 whose body is not text/event-stream is equally fatal — worth
    // covering separately because it is the failure mode a misconfigured proxy
    // or CDN in front of the app would actually produce.
    proxy.setStreamFault('content-type');
    proxy.dropAll();

    await expect
      .poll(() => readConnectionState(page), {
        message:
          'a 200 with a non-event-stream Content-Type should also end in ' +
          '"disconnected" (§2/§10)',
        timeout: 30_000,
      })
      .toBe('disconnected');
  });

  test('a mid-session reload re-establishes the stream cleanly', async ({ page }) => {
    await page.goto('/');
    await waitForPriceChange(page, 'AAPL');

    await page.reload();
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();

    await expect
      .poll(() => readConnectionState(page), {
        message: 'the stream should re-establish after a reload',
        timeout: 20_000,
      })
      .toBe('connected');
    await waitForPriceChange(page, 'AAPL', 30_000);
  });
});
