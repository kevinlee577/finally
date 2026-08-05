import { expect, test } from '@playwright/test';
import { api, chatActions, sel, sendChat } from './helpers';
import { FIXTURE_EXPECTATIONS, MOCK_TRIGGERS } from './mock-fixtures';

/**
 * PLAN.md §12 scenario 6 — "AI chat (mocked): send a message, receive a
 * response, trade execution appears inline".
 *
 * Runs against LLM_MOCK=true. Trigger phrases mirror backend/app/llm/mock.py
 * via ./mock-fixtures.ts; a failure caused by an unrecognised trigger is a
 * fixture-sync problem, not a chat bug.
 */

interface ChatAction {
  type: string;
  ticker?: string;
  side?: string;
  quantity?: number;
  status: 'executed' | 'failed';
  error?: string;
  fill_price?: number;
}

test.describe('AI chat (mocked)', () => {
  test('a chat turn returns the §9 response envelope', async ({ request }) => {
    const { status, body } = await api.chat(request, MOCK_TRIGGERS.analysisOnly);

    expect(status, `POST /api/chat should return 200 under LLM_MOCK, got ${JSON.stringify(body)}`)
      .toBe(200);
    expect(typeof body?.message, '§9 envelope requires a string `message`').toBe('string');
    expect(body.message.length, 'assistant message should not be empty').toBeGreaterThan(0);

    // The default fixture proposes nothing, so actions should be empty/absent.
    const actions = (body?.actions ?? []) as ChatAction[];
    expect(Array.isArray(actions), '`actions` must be an array when present').toBe(true);
    expect(actions.length, 'an analysis-only reply should carry no actions').toBe(0);
  });

  test('sending a message through the UI renders the reply', async ({ page }) => {
    await page.goto('/');
    const log = page.getByTestId(sel.chatMessages);
    await expect(log).toBeVisible();

    await sendChat(page, MOCK_TRIGGERS.analysisOnly);

    // The user's own message is echoed into the transcript.
    await expect(log.getByText(MOCK_TRIGGERS.analysisOnly, { exact: false })).toBeVisible();

    // An assistant turn arrives — identified by its "FinAlly" byline — and the
    // pending indicator clears.
    await expect(
      log.getByText('FinAlly', { exact: true }).first(),
      'an assistant turn should render in the transcript',
    ).toBeVisible({ timeout: 20_000 });

    // The default fixture's canned text, so this asserts the real reply landed.
    await expect(log.getByText(/concentrated in cash/i)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId(sel.chatLoading)).toHaveCount(0, { timeout: 20_000 });
  });

  test('a chat-driven trade executes and appears inline as an action', async ({ page, request }) => {
    const before = await api.portfolio(request);
    const qtyBefore = before.positions.find((p) => p.ticker === 'AAPL')?.quantity ?? 0;

    await page.goto('/');
    await expect(page.getByTestId(sel.chatMessages)).toBeVisible();

    await sendChat(page, MOCK_TRIGGERS.buyAapl);

    // §10: trade executions are shown inline as confirmations.
    await expect(
      chatActions(page, 'executed').first(),
      'an executed action row should render for the proposed trade (§9/§10)',
    ).toBeVisible({ timeout: 20_000 });

    await expect(chatActions(page)).toHaveCount(1);

    // The trade really happened server-side (§9 auto-execution).
    await expect
      .poll(async () => {
        const p = await api.portfolio(request);
        return p.positions.find((x) => x.ticker === 'AAPL')?.quantity ?? 0;
      }, {
        message: 'chat-issued buy should increase the AAPL position (§9 Auto-Execution)',
        timeout: 15_000,
      })
      .toBeGreaterThan(qtyBefore);

    const after = await api.portfolio(request);
    const delta = (after.positions.find((p) => p.ticker === 'AAPL')?.quantity ?? 0) - qtyBefore;
    expect(delta, 'the buy 10 aapl fixture should buy exactly 10 shares').toBeCloseTo(
      FIXTURE_EXPECTATIONS.buyAaplQuantity,
      4,
    );
    expect(after.cash_balance, 'cash should fall after a chat-issued buy').toBeLessThan(
      before.cash_balance,
    );
  });

  test('an executed trade action carries a fill_price (§9)', async ({ request }) => {
    const { body } = await api.chat(request, MOCK_TRIGGERS.buyMsft);
    const actions = (body?.actions ?? []) as ChatAction[];

    const executed = actions.find((a) => a.type === 'trade' && a.status === 'executed');
    expect(executed, 'the buy 5 msft fixture should execute').toBeDefined();
    expect(typeof executed!.fill_price, 'executed trades report a fill_price (§9)').toBe('number');
    expect(executed!.fill_price).toBeGreaterThan(0);
  });

  test('a failed chat trade is reported in actions, not hidden (§9)', async ({ page, request }) => {
    const before = await api.portfolio(request);

    await page.goto('/');
    await expect(page.getByTestId(sel.chatMessages)).toBeVisible();

    await sendChat(page, MOCK_TRIGGERS.failingBuy);

    // §9: the narration claims success while the action row reports the failure.
    // The frontend must render both — this is the contract's key asymmetry.
    await expect(
      chatActions(page, 'failed').first(),
      'an over-budget buy must render as a failed action row (§9 Response Envelope)',
    ).toBeVisible({ timeout: 20_000 });

    const { status, body } = await api.chat(request, MOCK_TRIGGERS.failingBuy);
    expect(status, 'a failing proposed trade is still a 200 chat turn (§9)').toBe(200);

    const actions = (body?.actions ?? []) as ChatAction[];
    const failed = actions.find((a) => a.status === 'failed');
    expect(
      failed,
      'an over-budget buy must come back as a failed action, not a 4xx and not silently dropped',
    ).toBeDefined();
    expect(typeof failed!.error, 'a failed action carries an `error` string (§9)').toBe('string');
    expect(failed!.fill_price, 'a failed trade has no fill price').toBeUndefined();

    const after = await api.portfolio(request);
    expect(after.cash_balance, 'a failed trade must not move cash (§7 atomicity)').toBeCloseTo(
      before.cash_balance,
      2,
    );
  });

  test('a mid-batch failure does not abort the rest of the batch (§7)', async ({ request }) => {
    // Fixture: AAPL buy 1 (ok), GOOGL buy 999999 (fails), MSFT buy 1 (ok).
    const { status, body } = await api.chat(request, MOCK_TRIGGERS.mixedBatch);
    expect(status).toBe(200);

    const actions = (body?.actions ?? []) as ChatAction[];
    expect(actions.length, 'all three proposed trades should be attempted (§7)').toBe(3);

    expect(
      actions.map((a) => a.status),
      'each trade succeeds or fails on its own merits, in order; a failure must not ' +
        'skip later trades (§7 "A failure does not abort the rest of the batch")',
    ).toEqual([...FIXTURE_EXPECTATIONS.mixedBatchStatuses]);

    // There is no third "skipped" status in the §9 envelope.
    for (const action of actions) {
      expect(['executed', 'failed']).toContain(action.status);
    }
  });

  test('trades execute before watchlist changes, each in array order (§9 step 7)', async ({
    request,
  }) => {
    await api.removeWatchlist(request, FIXTURE_EXPECTATIONS.watchlistTicker);

    const { body } = await api.chat(request, MOCK_TRIGGERS.rebalance);
    const actions = (body?.actions ?? []) as ChatAction[];

    expect(
      actions.map((a) => a.type),
      'all trades are attempted before any watchlist change (§9 step 7)',
    ).toEqual([...FIXTURE_EXPECTATIONS.rebalanceTypes]);

    await api.removeWatchlist(request, FIXTURE_EXPECTATIONS.watchlistTicker);
  });

  test('a chat-driven watchlist add is applied (§9)', async ({ request }) => {
    await api.removeWatchlist(request, FIXTURE_EXPECTATIONS.watchlistTicker);

    const { status, body } = await api.chat(request, MOCK_TRIGGERS.addWatchlist);
    expect(status).toBe(200);

    const actions = (body?.actions ?? []) as ChatAction[];
    const add = actions.find((a) => a.type === 'watchlist_add');
    expect(add, 'fixture should produce a watchlist_add action (§9)').toBeDefined();
    expect(add!.status).toBe('executed');

    const { watchlist } = await api.watchlist(request);
    expect(watchlist.map((w) => w.ticker)).toContain(FIXTURE_EXPECTATIONS.watchlistTicker);

    await api.removeWatchlist(request, FIXTURE_EXPECTATIONS.watchlistTicker);
  });

  test('malformed LLM output degrades to a generic reply with no actions (§9)', async ({
    request,
  }) => {
    const before = await api.portfolio(request);

    const { status, body } = await api.chat(request, MOCK_TRIGGERS.malformed);

    // §9: unparseable output is NOT an HTTP error — it is a normal 200 turn
    // carrying a generic reply. Only a missing API key is a 503 (§8).
    expect(
      status,
      'malformed LLM output must degrade in-band as a 200, not an HTTP error (§9)',
    ).toBe(200);
    expect(typeof body?.message, 'a fallback message should still be returned').toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    const actions = (body?.actions ?? []) as ChatAction[];
    expect(actions.length, 'no actions may execute when parsing fails (§9)').toBe(0);

    const after = await api.portfolio(request);
    expect(after.cash_balance).toBeCloseTo(before.cash_balance, 2);
  });

  test('conversation history survives a page reload (§9 persistence)', async ({ page }) => {
    const marker = MOCK_TRIGGERS.analysisOnly;

    await page.goto('/');
    await expect(page.getByTestId(sel.chatMessages)).toBeVisible();

    await sendChat(page, marker);
    await expect(page.getByTestId(sel.chatMessages).getByText(marker, { exact: false })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId(sel.chatMessages)).toBeVisible();

    // §9 steps 1 and 9 persist both turns to chat_messages, so a reload should
    // restore them.
    await expect(
      page.getByTestId(sel.chatMessages).getByText(marker, { exact: false }).first(),
      'chat history is persisted to chat_messages and should reload (§7/§9)',
    ).toBeVisible({ timeout: 15_000 });
  });
});
