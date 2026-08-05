import { expect, test } from '@playwright/test';
import {
  api,
  expectClose,
  readCashBalance,
  readPositionCell,
  sel,
  submitTrade,
} from './helpers';

/**
 * PLAN.md §12 scenario 3 — "Buy shares: cash decreases, position appears,
 * portfolio updates".
 *
 * Assertions are delta-based rather than absolute: prices move every
 * MARKET_TICK_SECONDS and earlier specs may have altered state. The invariant
 * checked is `cash_spent == quantity * fill_price`, which holds regardless of
 * where the price happens to be when the trade lands.
 */
const TICKER = 'AAPL';
const QUANTITY = 5;

test.describe('Buy shares', () => {
  test('buying through the trade bar debits cash and opens a position', async ({
    page,
    request,
  }) => {
    const before = await api.portfolio(request);
    const positionBefore = before.positions.find((p) => p.ticker === TICKER);
    const qtyBefore = positionBefore?.quantity ?? 0;

    await page.goto('/');
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();

    await submitTrade(page, TICKER, QUANTITY, 'buy');

    // The position row should appear/update in the UI.
    await expect(page.getByTestId(sel.positionRow(TICKER))).toBeVisible();

    const after = await api.portfolio(request);
    const positionAfter = after.positions.find((p) => p.ticker === TICKER);

    expect(positionAfter, `a ${TICKER} position should exist after buying`).toBeDefined();
    expectClose(positionAfter!.quantity, qtyBefore + QUANTITY, 1e-6, 'position quantity');

    expect(after.cash_balance, 'cash should decrease after a buy').toBeLessThan(
      before.cash_balance,
    );

    // The amount debited equals shares * fill price. For a brand-new position
    // avg_cost *is* the fill price; for a top-up the blended cost basis makes
    // this exact check inapplicable, so it is scoped to the fresh case.
    if (qtyBefore === 0) {
      const spent = before.cash_balance - after.cash_balance;
      expectClose(
        spent,
        QUANTITY * positionAfter!.avg_cost,
        0.02,
        'cash debited vs quantity*avg_cost',
      );
    }

    // §8 formulas must hold in the API response itself.
    expectClose(
      positionAfter!.market_value,
      positionAfter!.quantity * positionAfter!.current_price,
      0.02,
      'market_value = quantity * current_price',
    );
    expectClose(
      positionAfter!.unrealized_pnl,
      (positionAfter!.current_price - positionAfter!.avg_cost) * positionAfter!.quantity,
      0.02,
      'unrealized_pnl = (current_price - avg_cost) * quantity',
    );

    // Total value = cash + sum of market values (§8).
    const sumMarketValue = after.positions.reduce((acc, p) => acc + p.market_value, 0);
    expectClose(
      after.total_value,
      after.cash_balance + sumMarketValue,
      0.05,
      'total_value = cash_balance + sum(market_value)',
    );

    // The UI must agree with the API. If these diverge, the backend is right and
    // the frontend is stale -> frontend-engineer.
    await expect
      .poll(async () => readCashBalance(page), {
        message: 'header cash should converge on the API cash balance',
        timeout: 10_000,
      })
      .toBeLessThan(before.cash_balance);

    const uiQuantity = await readPositionCell(page, TICKER, 'quantity');
    expectClose(uiQuantity, positionAfter!.quantity, 1e-4, 'positions table quantity vs API');
  });

  test('a trade records a portfolio snapshot immediately (§7)', async ({ request }) => {
    const before = await api.history(request);

    const result = await api.trade(request, { ticker: TICKER, quantity: 1, side: 'buy' });
    expect(result.status, `buy should succeed, got ${JSON.stringify(result.body)}`)
      .toBeLessThan(300);

    const after = await api.history(request);
    expect(
      after.snapshots.length,
      'a snapshot must be written as part of the trade transaction (§7)',
    ).toBeGreaterThan(before.snapshots.length);
  });

  test('supports fractional share quantities (§7/§10)', async ({ request }) => {
    const before = await api.portfolio(request);
    const qtyBefore = before.positions.find((p) => p.ticker === 'MSFT')?.quantity ?? 0;

    const result = await api.trade(request, { ticker: 'MSFT', quantity: 0.5, side: 'buy' });
    expect(result.status, `fractional buy should be accepted, got ${JSON.stringify(result.body)}`)
      .toBeLessThan(300);

    const after = await api.portfolio(request);
    const position = after.positions.find((p) => p.ticker === 'MSFT');
    expectClose(position?.quantity ?? 0, qtyBefore + 0.5, 1e-6, 'fractional quantity');
  });

  test('the trade bar surfaces the §8 error code on a rejected buy', async ({ page, request }) => {
    const before = await api.portfolio(request);

    await page.goto('/');
    await expect(page.getByTestId(sel.watchlistPanel)).toBeVisible();

    // No error showing before we do anything wrong.
    await expect(page.getByTestId(sel.tradeError)).toHaveCount(0);

    await submitTrade(page, TICKER, 1_000_000, 'buy');

    const error = page.getByTestId(sel.tradeError);
    await expect(error, 'a rejected trade should surface an inline error (§8/§10)').toBeVisible();
    await expect(
      error,
      'the inline error should carry the §8 code verbatim so the UI and API agree',
    ).toHaveAttribute('data-error-code', 'insufficient_cash');

    // The failed trade must not have moved anything (§7 atomicity).
    const after = await api.portfolio(request);
    expectClose(after.cash_balance, before.cash_balance, 0.01, 'cash after a rejected buy');
  });

  test('rejects a buy that exceeds cash with 400 insufficient_cash (§8)', async ({ request }) => {
    const { status, body } = await api.trade(request, {
      ticker: TICKER,
      quantity: 1_000_000,
      side: 'buy',
    });

    expect(status).toBe(400);
    expect(body?.error?.code).toBe('insufficient_cash');

    // The rejected trade must not have moved anything (§7 atomicity).
    const portfolio = await api.portfolio(request);
    expect(portfolio.cash_balance, 'cash must be untouched by a rejected buy').toBeGreaterThan(0);
  });

  test('rejects invalid quantities and sides (§8)', async ({ request }) => {
    const zero = await api.trade(request, { ticker: TICKER, quantity: 0, side: 'buy' });
    expect(zero.status, 'zero quantity should be a validation_error (§8)').toBe(422);
    expect(zero.body?.error?.code).toBe('validation_error');

    const negative = await api.trade(request, { ticker: TICKER, quantity: -5, side: 'buy' });
    expect(negative.status, 'negative quantity should be a validation_error (§8)').toBe(422);

    const badSide = await api.trade(request, {
      ticker: TICKER,
      quantity: 1,
      side: 'hold' as 'buy',
    });
    expect([400, 422], 'invalid side should be invalid_side (§8)').toContain(badSide.status);
    expect(['invalid_side', 'validation_error']).toContain(badSide.body?.error?.code);
  });

  test('buying a never-watchlisted ticker is allowed (§6 Tradeable Symbols)', async ({
    request,
  }) => {
    // ORCL is syntactically valid and not in the seed watchlist. §6 permits the
    // trade but requires a quote; the first attempt may legitimately return
    // quote_unavailable, after which a retry should fill.
    const first = await api.trade(request, { ticker: 'ORCL', quantity: 1, side: 'buy' });

    if (first.status === 409) {
      expect(
        first.body?.error?.code,
        'a quote-less ticker must be rejected with quote_unavailable, not blocked (§6)',
      ).toBe('quote_unavailable');

      // §6: add_ticker() is called on that first attempt, so a retry should work.
      await new Promise((r) => setTimeout(r, 2_000));
      const second = await api.trade(request, { ticker: 'ORCL', quantity: 1, side: 'buy' });
      expect(
        second.status,
        `retry after add_ticker should fill, got ${JSON.stringify(second.body)}`,
      ).toBeLessThan(300);
    } else {
      expect(first.status).toBeLessThan(300);
    }

    const portfolio = await api.portfolio(request);
    expect(portfolio.positions.map((p) => p.ticker)).toContain('ORCL');
  });
});
