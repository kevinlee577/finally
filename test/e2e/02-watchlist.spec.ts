import { expect, test } from '@playwright/test';
import { SCRATCH_TICKER, addWatchlistTicker, api, sel } from './helpers';

/**
 * PLAN.md §12 scenario 2 — "Add and remove a ticker from the watchlist".
 *
 * Also covers the §8 normalization and error-envelope contracts, since the
 * watchlist endpoints are where they are most cheaply observable.
 */
test.describe('Watchlist add and remove', () => {
  // Leave no residue for later specs regardless of how a test exits.
  test.afterEach(async ({ request }) => {
    await api.removeWatchlist(request, SCRATCH_TICKER);
  });

  test('adds a ticker through the UI and it starts streaming', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();
    await expect(page.getByTestId(sel.watchlistRow(SCRATCH_TICKER))).toHaveCount(0);

    await addWatchlistTicker(page, SCRATCH_TICKER);

    // Appears in the UI...
    await expect(page.getByTestId(sel.watchlistRow(SCRATCH_TICKER))).toBeVisible();

    // ...and is genuinely persisted server-side (distinguishes an optimistic UI
    // update from a real add).
    const { watchlist } = await api.watchlist(request);
    expect(
      watchlist.map((w) => w.ticker),
      'added ticker should be persisted to the watchlist table',
    ).toContain(SCRATCH_TICKER);

    // §6 Ticker Tracking Set: adding it must subscribe it to market data, so a
    // price should arrive shortly.
    await expect
      .poll(
        async () => {
          const entry = (await api.watchlist(request)).watchlist.find(
            (w) => w.ticker === SCRATCH_TICKER,
          );
          return entry?.price ?? null;
        },
        {
          message:
            `${SCRATCH_TICKER} should receive a quote after being added ` +
            '(§6 Ticker Tracking Set)',
          timeout: 15_000,
        },
      )
      .not.toBeNull();
  });

  test('removes a ticker through the UI', async ({ page, request }) => {
    await api.addWatchlist(request, SCRATCH_TICKER);

    await page.goto('/');
    const row = page.getByTestId(sel.watchlistRow(SCRATCH_TICKER));
    await expect(row).toBeVisible();

    // The remove control only becomes opaque on row hover; hover first so the
    // click is a faithful simulation of what a user does.
    await row.hover();
    await page.getByTestId(sel.watchlistRemove(SCRATCH_TICKER)).click();

    // §6 is explicit that removal must be driven from the DELETE response, not
    // from the SSE stream (which may not reflect it for ~500ms, or ever). So the
    // row should disappear promptly.
    await expect(row).toHaveCount(0, { timeout: 5_000 });

    const { watchlist } = await api.watchlist(request);
    expect(watchlist.map((w) => w.ticker)).not.toContain(SCRATCH_TICKER);
  });

  test('the watchlist surfaces the §8 error code on a duplicate add', async ({ page, request }) => {
    await api.addWatchlist(request, SCRATCH_TICKER);

    await page.goto('/');
    await expect(page.getByTestId(sel.watchlistRow(SCRATCH_TICKER))).toBeVisible();

    await addWatchlistTicker(page, SCRATCH_TICKER);

    const error = page.getByTestId(sel.watchlistError);
    await expect(error, 'a duplicate add should surface an inline error (§8/§10)').toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'duplicate_ticker');

    // The existing row is untouched — no duplicate, no removal.
    await expect(page.getByTestId(sel.watchlistRow(SCRATCH_TICKER))).toHaveCount(1);
  });

  test('normalizes ticker case and whitespace (§8)', async ({ request }) => {
    const { status, body } = await api.addWatchlist(request, '  pypl  ');

    expect(status, 'POST /api/watchlist should return 201 (§8)').toBe(201);
    expect(body?.ticker, 'ticker should be upper-cased and trimmed (§8)').toBe('PYPL');

    const { watchlist } = await api.watchlist(request);
    expect(watchlist.map((w) => w.ticker)).toContain('PYPL');
  });

  test('rejects a duplicate ticker with 409 duplicate_ticker (§8)', async ({ request }) => {
    const first = await api.addWatchlist(request, SCRATCH_TICKER);
    expect(first.status).toBe(201);

    const second = await api.addWatchlist(request, SCRATCH_TICKER);
    expect(second.status).toBe(409);
    expect(second.body?.error?.code).toBe('duplicate_ticker');
    expect(typeof second.body?.error?.message, 'error envelope needs a human message')
      .toBe('string');
  });

  test('rejects a syntactically invalid ticker with 400 invalid_ticker (§8)', async ({ request }) => {
    for (const bad of ['12X', '', '!!']) {
      const { status, body } = await api.addWatchlist(request, bad);
      expect(
        [400, 422],
        `"${bad}" should be rejected as invalid_ticker/validation_error (§8), got ${status}`,
      ).toContain(status);
      expect(['invalid_ticker', 'validation_error']).toContain(body?.error?.code);
    }
  });

  test('removing an unwatchlisted ticker returns 404 not_watchlisted (§8)', async ({ request }) => {
    // ZZZZ is syntactically valid but never seeded.
    const res = await api.removeWatchlist(request, 'ZZZZ');
    expect(res.status, 'DELETE for a ticker with no watchlist row (§8)').toBe(404);
  });

  test('successful delete returns 204 with no body (§8)', async ({ request }) => {
    await api.addWatchlist(request, SCRATCH_TICKER);
    const res = await api.removeWatchlist(request, SCRATCH_TICKER);
    expect(res.status).toBe(204);
  });
});
