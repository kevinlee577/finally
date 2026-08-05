import { expect, test } from '@playwright/test';
import {
  api,
  ensurePosition,
  expectClose,
  readPositionCell,
  sel,
  submitTrade,
} from './helpers';

/**
 * PLAN.md §12 scenario 4 — "Sell shares: cash increases, position updates or
 * disappears".
 *
 * Each test provisions its own position via the API so it does not depend on
 * the buy spec having run.
 */
const TICKER = 'NVDA';

test.describe('Sell shares', () => {
  test('a partial sell credits cash and reduces the position', async ({ page, request }) => {
    await ensurePosition(request, TICKER, 4);

    const before = await api.portfolio(request);
    const positionBefore = before.positions.find((p) => p.ticker === TICKER)!;
    const qtyBefore = positionBefore.quantity;

    await page.goto('/');
    await expect(page.getByTestId(sel.positionRow(TICKER))).toBeVisible();

    await submitTrade(page, TICKER, 2, 'sell');

    await expect
      .poll(async () => {
        const p = await api.portfolio(request);
        return p.positions.find((x) => x.ticker === TICKER)?.quantity ?? 0;
      }, { message: 'position quantity should drop after a partial sell' })
      .toBeLessThan(qtyBefore);

    const after = await api.portfolio(request);
    const positionAfter = after.positions.find((p) => p.ticker === TICKER);

    expect(positionAfter, 'a partial sell must leave the position open').toBeDefined();
    expectClose(positionAfter!.quantity, qtyBefore - 2, 1e-6, 'remaining quantity');
    expect(after.cash_balance, 'cash should increase after a sell').toBeGreaterThan(
      before.cash_balance,
    );

    // §7: a sell does not change cost basis.
    expectClose(
      positionAfter!.avg_cost,
      positionBefore.avg_cost,
      0.01,
      'avg_cost is unchanged by a sell',
    );

    // UI agrees with API.
    const uiQuantity = await readPositionCell(page, TICKER, 'quantity');
    expectClose(uiQuantity, positionAfter!.quantity, 1e-4, 'positions table quantity vs API');
  });

  test('selling the entire holding removes the position row', async ({ page, request }) => {
    await ensurePosition(request, TICKER, 3);
    const held = (await api.portfolio(request)).positions.find((p) => p.ticker === TICKER)!.quantity;
    expect(held).toBeGreaterThan(0);

    await page.goto('/');
    await expect(page.getByTestId(sel.positionRow(TICKER))).toBeVisible();

    await submitTrade(page, TICKER, held, 'sell');

    // §7 "Closing a position": the row is deleted, not left at quantity 0.
    await expect
      .poll(async () => {
        const p = await api.portfolio(request);
        return p.positions.some((x) => x.ticker === TICKER);
      }, { message: 'a fully closed position must be deleted from the positions table (§7)' })
      .toBe(false);

    await expect(page.getByTestId(sel.positionRow(TICKER))).toHaveCount(0, { timeout: 10_000 });
  });

  test('rejects selling more than held with 400 insufficient_shares (§8)', async ({ request }) => {
    await ensurePosition(request, TICKER, 2);
    const held = (await api.portfolio(request)).positions.find((p) => p.ticker === TICKER)!.quantity;

    const { status, body } = await api.trade(request, {
      ticker: TICKER,
      quantity: held + 100,
      side: 'sell',
    });

    expect(status).toBe(400);
    expect(
      body?.error?.code,
      'a position exists but is too small -> insufficient_shares, not no_position (§8)',
    ).toBe('insufficient_shares');

    // Nothing should have changed.
    const after = await api.portfolio(request);
    expectClose(
      after.positions.find((p) => p.ticker === TICKER)!.quantity,
      held,
      1e-6,
      'quantity unchanged after a rejected sell',
    );
  });

  test('rejects selling a ticker with no position with 404 no_position (§8)', async ({
    request,
  }) => {
    // JPM is watchlisted but should have no open position.
    const portfolio = await api.portfolio(request);
    const hasPosition = portfolio.positions.some((p) => p.ticker === 'JPM');
    test.skip(hasPosition, 'JPM unexpectedly has an open position; cannot test no_position here');

    const { status, body } = await api.trade(request, {
      ticker: 'JPM',
      quantity: 1,
      side: 'sell',
    });

    expect(status).toBe(404);
    expect(body?.error?.code).toBe('no_position');
  });

  test('closing an unwatchlisted position stops tracking it (§6)', async ({ request }) => {
    // Build the exact situation §6 describes: a held ticker removed from the
    // watchlist, then fully sold. Tracking must stop only at the sell.
    const scratch = 'ORCL';
    await ensurePosition(request, scratch, 1);

    // Remove from the watchlist if present; the position must keep it tracked.
    await api.removeWatchlist(request, scratch);

    const priced = await api.portfolio(request);
    const position = priced.positions.find((p) => p.ticker === scratch);
    expect(position, 'position should survive watchlist removal').toBeDefined();
    expect(
      position!.current_price,
      'a held-but-unwatchlisted ticker must keep receiving quotes (§6)',
    ).toBeGreaterThan(0);

    // Now close it entirely.
    const sell = await api.trade(request, {
      ticker: scratch,
      quantity: position!.quantity,
      side: 'sell',
    });
    expect(sell.status, `closing sell should succeed, got ${JSON.stringify(sell.body)}`)
      .toBeLessThan(300);

    const after = await api.portfolio(request);
    expect(after.positions.some((p) => p.ticker === scratch)).toBe(false);
  });
});
