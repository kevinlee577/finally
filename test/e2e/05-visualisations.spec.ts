import { expect, test } from '@playwright/test';
import { api, ensurePosition, sel } from './helpers';

/**
 * PLAN.md §12 scenario 5 — "Portfolio visualization: heatmap renders with
 * correct colors, P&L chart has data points".
 *
 * §12 "Heatmap color thresholds" defines the assertable rule: green when
 * unrealized P&L > 0, red when < 0, neutral when exactly 0. Reading a computed
 * fill colour out of a treemap is unreliable, so the suite asserts on the
 * `data-pnl-sign` attribute the frontend emits (positive/negative/zero).
 *
 * The colour rule is checked against the tile's OWN `data-value` (the P&L it
 * rendered), not against a separately fetched API figure. Both come from the
 * same render, so the assertion is exact and race-free.
 *
 * Comparing the sign to a separate `GET /api/portfolio` read is NOT sound: the
 * two are observations of a continuously moving quantity taken at different
 * instants, so a position hovering near break-even legitimately disagrees. That
 * produced a real intermittent failure (API said P&L 0.06, tile said "zero"),
 * and widening a tolerance would only have made the window smaller rather than
 * fixing the logic. The API value is still cross-checked below, but loosely and
 * for a different purpose: proving the tile shows live data rather than a stub.
 */
const TICKER = 'GOOGL';

/** Map a P&L value to the sign the tile should carry (§12 thresholds). */
function expectedSign(pnl: number): 'positive' | 'negative' | 'zero' {
  if (pnl > 0) return 'positive';
  if (pnl < 0) return 'negative';
  return 'zero';
}

test.describe('Portfolio visualisations', () => {
  test('heatmap renders a tile per position, signed to match the API P&L', async ({
    page,
    request,
  }) => {
    await ensurePosition(request, TICKER, 3);

    await page.goto('/');
    await expect(page.getByTestId(sel.heatmap)).toBeVisible();

    const portfolio = await api.portfolio(request);
    expect(portfolio.positions.length, 'test needs at least one open position').toBeGreaterThan(0);

    for (const position of portfolio.positions) {
      const tile = page.getByTestId(sel.heatmapTile(position.ticker));
      await expect(tile, `${position.ticker} should have a heatmap tile`).toBeVisible();

      // Read sign and value together — one render, one instant, no race.
      const [sign, rawValue] = await Promise.all([
        tile.getAttribute('data-pnl-sign'),
        tile.getAttribute('data-value'),
      ]);

      const tilePnl = Number.parseFloat(rawValue ?? '');
      expect(
        Number.isNaN(tilePnl),
        `${position.ticker} tile should publish its P&L as data-value`,
      ).toBe(false);

      // §12's colour rule, asserted exactly against the value the tile rendered.
      expect(
        sign,
        `${position.ticker} tile reported P&L ${tilePnl} but was signed "${sign}" ` +
          '(§12 heatmap colour thresholds: >0 green, <0 red, 0 neutral)',
      ).toBe(expectedSign(tilePnl));

      // Separately, and loosely: the tile is showing live data, not a stub.
      // A generous tolerance covers price movement between the two reads.
      const drift = Math.abs(tilePnl - position.unrealized_pnl);
      const allowed = Math.max(1, Math.abs(position.market_value) * 0.05);
      expect(
        drift,
        `${position.ticker} tile P&L ${tilePnl} is implausibly far from the API's ` +
          `${position.unrealized_pnl}; the tile may not be tracking live prices`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  test('heatmap weights positions against total value including cash (§8)', async ({ request }) => {
    await ensurePosition(request, TICKER, 3);
    const portfolio = await api.portfolio(request);

    const totalWeight = portfolio.positions.reduce(
      (acc, p) => acc + p.market_value / portfolio.total_value,
      0,
    );

    // Weight is against total value *including* cash, so with any cash left the
    // position weights must sum to less than 1.
    expect(
      totalWeight,
      'position weights are computed against total value including cash (§8)',
    ).toBeLessThan(1);
    expect(totalWeight).toBeGreaterThan(0);
  });

  test('P&L chart renders with data points', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId(sel.pnlChart)).toBeVisible();

    const { snapshots } = await api.history(request);
    expect(snapshots.length, 'history should have at least the seed snapshot (§7)')
      .toBeGreaterThan(0);

    // The chart is drawn as SVG/canvas; assert it rendered actual geometry
    // rather than an empty frame.
    const chart = page.getByTestId(sel.pnlChart);
    const pointCount = await chart.getAttribute('data-point-count');
    if (pointCount !== null) {
      expect(Number.parseInt(pointCount, 10), 'chart should plot at least one point')
        .toBeGreaterThan(0);
    } else {
      const drawn = await chart.locator('path, circle, rect, polyline').count();
      expect(drawn, 'P&L chart should render plotted geometry, not an empty frame')
        .toBeGreaterThan(0);
    }
  });

  test('the background snapshot task keeps appending points (§7)', async ({ request }) => {
    // docker-compose.test.yml sets SNAPSHOT_INTERVAL_SECONDS=1, so new snapshots
    // should appear within a few seconds without any trade.
    const before = await api.history(request);

    await expect
      .poll(async () => (await api.history(request)).snapshots.length, {
        message:
          'the 30s (here 1s) background snapshot task should append rows (§7 Portfolio ' +
          'Snapshot Semantics). If this fails, either the task is not running or ' +
          'SNAPSHOT_INTERVAL_SECONDS is not being honoured.',
        timeout: 20_000,
      })
      .toBeGreaterThan(before.snapshots.length);
  });

  test('history is ordered by recorded_at ascending (§7)', async ({ request }) => {
    const { snapshots } = await api.history(request);
    const times = snapshots.map((s) => Date.parse(s.recorded_at));

    expect(times.every((t) => !Number.isNaN(t)), 'all recorded_at values should parse').toBe(true);

    const sorted = [...times].sort((a, b) => a - b);
    expect(times, 'GET /api/portfolio/history must be ascending by recorded_at (§7)')
      .toEqual(sorted);
  });

  test('positions table matches the API row for row', async ({ page, request }) => {
    await ensurePosition(request, TICKER, 3);

    await page.goto('/');
    await expect(page.getByTestId(sel.positionsTable)).toBeVisible();

    const portfolio = await api.portfolio(request);
    for (const position of portfolio.positions) {
      await expect(
        page.getByTestId(sel.positionRow(position.ticker)),
        `${position.ticker} should appear in the positions table`,
      ).toBeVisible();
    }
  });
});
