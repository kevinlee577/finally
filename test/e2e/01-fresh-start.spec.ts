import { expect, test } from '@playwright/test';
import {
  DEFAULT_TICKERS,
  STARTING_CASH,
  api,
  expectClose,
  readCashBalance,
  readConnectionState,
  readTotalValue,
  readWatchlistPrice,
  sel,
  waitForPriceChange,
} from './helpers';

/**
 * PLAN.md §12 scenario 1 — "Fresh start: default watchlist appears, $10k
 * balance shown, prices are streaming".
 *
 * This spec MUST run before any trading spec: it asserts the untouched seed
 * state from §7. The numbered filenames plus `workers: 1` guarantee that
 * ordering. The first test fails loudly with an explicit message if the
 * database is not actually fresh, so a stale-container run is never
 * misreported as a product bug.
 */
test.describe('Fresh start', () => {
  test('database is in its freshly seeded state (suite precondition)', async ({ request }) => {
    const portfolio = await api.portfolio(request);

    expect(
      portfolio.positions.length,
      'E2E suite precondition failed: the app already has open positions, so this ' +
        'run is not against a freshly seeded database. Recreate the stack ' +
        '(docker compose -f test/docker-compose.test.yml down -v, then up --build). ' +
        'This is a harness/environment problem, not a product bug.',
    ).toBe(0);

    expectClose(portfolio.cash_balance, STARTING_CASH, 0.01, 'seeded cash balance');
  });

  test('health endpoint reports ok with chat enabled under LLM_MOCK', async ({ request }) => {
    const { status, body } = await api.health(request);

    expect(status).toBe(200);
    expect(body.status, 'GET /api/health status (§8)').toBe('ok');
    // §5/§8: LLM_MOCK=true must enable chat even with an empty OPENROUTER_API_KEY.
    expect(
      body.chat_enabled,
      'chat_enabled should be true because docker-compose.test.yml sets LLM_MOCK=true (§5/§8)',
    ).toBe(true);
  });

  test('API seeds all ten default watchlist tickers', async ({ request }) => {
    const { watchlist } = await api.watchlist(request);
    const tickers = watchlist.map((w) => w.ticker).sort();

    expect(tickers, 'seeded watchlist from §7 "Default Seed Data"').toEqual(
      [...DEFAULT_TICKERS].sort(),
    );
  });

  test('portfolio history has a baseline snapshot at $10,000', async ({ request }) => {
    // §7: one seed snapshot exists immediately so the P&L chart is never empty.
    const { snapshots } = await api.history(request);

    expect(snapshots.length, 'a baseline snapshot should exist on first launch (§7)')
      .toBeGreaterThan(0);
    expectClose(snapshots[0].total_value, STARTING_CASH, 0.01, 'baseline snapshot value');

    // §7/§8: timestamps are UTC RFC 3339, not Unix seconds.
    expect(
      snapshots[0].recorded_at,
      'recorded_at should be UTC RFC 3339 per §7 "Timestamp format"',
    ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  });

  test('UI shows the default watchlist, $10k cash, and a connected indicator', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();

    for (const ticker of DEFAULT_TICKERS) {
      await expect(
        page.getByTestId(sel.watchlistRow(ticker)),
        `${ticker} should appear in the watchlist panel`,
      ).toBeVisible();
    }

    const cash = await readCashBalance(page);
    expectClose(cash, STARTING_CASH, 0.01, 'cash balance in header');

    // With no positions, total value is all cash (§8 formulas).
    const totalValue = await readTotalValue(page);
    expectClose(totalValue, STARTING_CASH, 0.01, 'total portfolio value in header');

    await expect(page.getByTestId(sel.connectionStatus)).toBeVisible();
    await expect
      .poll(() => readConnectionState(page), {
        message: 'connection indicator should reach "connected" (§2/§10)',
        timeout: 15_000,
      })
      .toBe('connected');
  });

  test('prices stream live into the watchlist', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();

    // Every seeded ticker should show a price (the simulator seeds the cache at
    // startup, so none should be blank).
    for (const ticker of DEFAULT_TICKERS) {
      const price = await readWatchlistPrice(page, ticker);
      expect(Number.isNaN(price), `${ticker} should render a numeric price`).toBe(false);
      expect(price, `${ticker} price should be positive`).toBeGreaterThan(0);
    }

    // Proof of streaming: a price actually moves.
    const { before, after } = await waitForPriceChange(page, 'AAPL');
    expect(after).not.toBe(before);
  });

  test('empty-state placeholders render for positions and heatmap', async ({ page }) => {
    await page.goto('/');

    // §8: a fresh account renders an empty heatmap with a placeholder, not an
    // error or a blank panel.
    await expect(
      page.getByTestId(sel.heatmapEmpty),
      'heatmap should show its placeholder when flat (§8)',
    ).toBeVisible();

    await expect(
      page.getByTestId(sel.positionsEmpty),
      'positions panel should show a placeholder when flat',
    ).toBeVisible();
  });
});
