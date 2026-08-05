import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Shared helpers, selectors and API clients for the FinAlly E2E suite.
 *
 * Three design notes the specs depend on:
 *
 * 1. SELECTORS MATCH THE FRONTEND'S ACTUAL MARKUP (`frontend/components/*.tsx`).
 *    Every numeric element also carries a `data-value` attribute holding the raw
 *    unformatted number, so assertions never have to strip `$`, commas, or
 *    locale formatting.
 *
 * 2. VALUE ACCESSORS PREFER `data-value` AND FALL BACK TO TEXT. If a
 *    presentational change ever drops the attribute, the suite degrades to
 *    parsing the rendered string rather than failing outright.
 *
 * 3. SPECS ASSERT AGAINST BOTH THE UI AND THE REST API. That is what lets the
 *    report attribute a failure to an owner: if the API is right and the UI
 *    disagrees, it is a frontend bug; if the API itself is wrong, it is a
 *    backend bug.
 */

// --- Constants from PLAN.md §7 "Default Seed Data" ---

export const DEFAULT_TICKERS = [
  'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA',
  'NVDA', 'META', 'JPM', 'V', 'NFLX',
] as const;

export const STARTING_CASH = 10_000.0;

/** Ticker used by watchlist add/remove tests — deliberately not a seed ticker. */
export const SCRATCH_TICKER = 'PYPL';

// --- Selectors ---

export const sel = {
  // Header. `connection-status` carries data-state; the inner dot is separate.
  connectionStatus: 'connection-status',
  // Manual re-subscribe, rendered ONLY in the disconnected (red) state.
  reconnectButton: 'reconnect-button',
  cashBalance: 'cash-balance',
  totalValue: 'total-value',
  unrealizedPnl: 'unrealized-pnl',

  // Watchlist
  watchlistPanel: 'watchlist-panel',
  watchlist: 'watchlist',
  watchlistEmpty: 'watchlist-empty',
  // Rendered only on failure; carries data-error-code with the §8 code.
  watchlistError: 'watchlist-error',
  watchlistRow: (t: string) => `watchlist-row-${t}`,
  watchlistPrice: (t: string) => `watchlist-price-${t}`,
  watchlistChangePct: (t: string) => `watchlist-change-pct-${t}`,
  watchlistSparkline: (t: string) => `watchlist-sparkline-${t}`,
  watchlistAddInput: 'watchlist-add-input',
  watchlistAddSubmit: 'watchlist-add-submit',
  watchlistRemove: (t: string) => `watchlist-remove-${t}`,

  // Trade bar
  tradeBar: 'trade-bar',
  tradeTickerInput: 'trade-ticker-input',
  tradeQuantityInput: 'trade-quantity-input',
  tradeBuyButton: 'trade-buy-button',
  tradeSellButton: 'trade-sell-button',
  tradeStatus: 'trade-status',
  // Rendered only on failure; carries data-error-code with the §8 code.
  tradeError: 'trade-error',

  // Positions
  positionsTable: 'positions-table',
  positionsEmpty: 'positions-empty',
  positionRow: (t: string) => `position-row-${t}`,
  positionQuantity: (t: string) => `position-quantity-${t}`,
  positionAvgCost: (t: string) => `position-avg-cost-${t}`,
  positionPrice: (t: string) => `position-price-${t}`,
  positionMarketValue: (t: string) => `position-market-value-${t}`,
  positionPnl: (t: string) => `position-pnl-${t}`,
  positionChangePct: (t: string) => `position-change-pct-${t}`,

  // Visualisations. Tiles carry data-pnl-sign (positive/negative/zero).
  heatmap: 'portfolio-heatmap',
  heatmapEmpty: 'heatmap-empty',
  heatmapTile: (t: string) => `heatmap-tile-${t}`,
  pnlChart: 'pnl-chart',
  mainChart: 'main-chart',

  // Chat. Messages carry data-role, actions carry data-status.
  chatPanel: 'chat-panel',
  chatMessages: 'chat-messages',
  chatMessage: 'chat-message',
  chatInput: 'chat-input',
  chatSend: 'chat-send',
  chatLoading: 'chat-loading',
  chatActions: 'chat-actions',
  chatAction: 'chat-action',
  chatDisabledNotice: 'chat-disabled-notice',
} as const;

// --- Numeric parsing ---

/**
 * Parse a displayed money/percentage string into a number.
 * Handles "$8,450.00", "−0.02%" (U+2212 minus), "(32.00)", and the em-dash
 * placeholder the UI shows when a value is unknown.
 */
export function parseNumeric(raw: string | null): number {
  if (raw === null) return NaN;
  const text = raw.trim().replace(/−/g, '-'); // unicode minus -> ASCII
  if (text === '' || text === '—' || text === '–' || text === '-' || text === 'N/A') {
    return NaN;
  }
  const isParenNegative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()$,%\s+]/g, '').replace(/[^0-9.\-eE]/g, '');
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) return NaN;
  return isParenNegative ? -Math.abs(value) : value;
}

/** Read a number from a locator, preferring `data-value` over rendered text. */
async function numberFrom(locator: Locator): Promise<number> {
  const dataValue = await locator.getAttribute('data-value');
  if (dataValue !== null && dataValue.trim() !== '') {
    const parsed = Number.parseFloat(dataValue);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return parseNumeric(await locator.textContent());
}

/** Read a numeric value from an element identified by test id. */
export async function readNumeric(page: Page, testId: string): Promise<number> {
  const locator = page.getByTestId(testId);
  await expect(locator, `${testId} should be present`).toBeVisible();
  return numberFrom(locator);
}

/** Assert two floats match within a tolerance (money rounds to 2dp per §7). */
export function expectClose(actual: number, expected: number, tolerance = 0.01, label = ''): void {
  expect(
    Math.abs(actual - expected),
    `${label} expected ~${expected}, got ${actual} (tolerance ${tolerance})`,
  ).toBeLessThanOrEqual(tolerance);
}

// --- Convenience accessors --------------------------------------------------

export const readCashBalance = (page: Page) => readNumeric(page, sel.cashBalance);
export const readTotalValue = (page: Page) => readNumeric(page, sel.totalValue);
export const readWatchlistPrice = (page: Page, ticker: string) =>
  readNumeric(page, sel.watchlistPrice(ticker));
export const readWatchlistChangePct = (page: Page, ticker: string) =>
  readNumeric(page, sel.watchlistChangePct(ticker));

/** Positions-table cell accessors, keyed by the column name. */
const POSITION_CELL = {
  quantity: sel.positionQuantity,
  avgCost: sel.positionAvgCost,
  currentPrice: sel.positionPrice,
  marketValue: sel.positionMarketValue,
  unrealizedPnl: sel.positionPnl,
  changePercent: sel.positionChangePct,
} as const;

export const readPositionCell = (
  page: Page,
  ticker: string,
  column: keyof typeof POSITION_CELL,
) => readNumeric(page, POSITION_CELL[column](ticker));

/** Read the connection indicator's state (connected/reconnecting/disconnected). */
export async function readConnectionState(page: Page): Promise<string | null> {
  const indicator = page.getByTestId(sel.connectionStatus);
  if ((await indicator.count()) === 0) return null;
  return indicator.first().getAttribute('data-state');
}

// --- Interaction helpers ----------------------------------------------------

/** Fill the trade bar and submit. Waits for the button to become enabled. */
export async function submitTrade(
  page: Page,
  ticker: string,
  quantity: number | string,
  side: 'buy' | 'sell',
): Promise<void> {
  await page.getByTestId(sel.tradeTickerInput).fill(ticker);
  await page.getByTestId(sel.tradeQuantityInput).fill(String(quantity));

  const button = page.getByTestId(side === 'buy' ? sel.tradeBuyButton : sel.tradeSellButton);
  await expect(button, `${side} button should enable once the form is valid`).toBeEnabled();
  await button.click();
}

export async function addWatchlistTicker(page: Page, ticker: string): Promise<void> {
  await page.getByTestId(sel.watchlistAddInput).fill(ticker);
  await page.getByTestId(sel.watchlistAddSubmit).click();
}

export async function sendChat(page: Page, message: string): Promise<void> {
  await page.getByTestId(sel.chatInput).fill(message);
  const send = page.getByTestId(sel.chatSend);
  await expect(send).toBeEnabled();
  await send.click();
}

/** Chat messages filtered by role. */
export const chatMessages = (page: Page, role: 'user' | 'assistant') =>
  page.locator(`[data-testid="${sel.chatMessage}"][data-role="${role}"]`);

/** Action rows rendered inline in the chat transcript, optionally by status. */
export const chatActions = (page: Page, status?: 'executed' | 'failed') =>
  page.locator(
    status
      ? `[data-testid="${sel.chatAction}"][data-status="${status}"]`
      : `[data-testid="${sel.chatAction}"]`,
  );

// --- REST API clients (PLAN.md §8) ---

export interface Position {
  ticker: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  change_percent: number;
}

export interface Portfolio {
  cash_balance: number;
  total_value: number;
  unrealized_pnl: number;
  positions: Position[];
}

export interface ApiError {
  error: { code: string; message: string };
}

export const api = {
  async health(request: APIRequestContext) {
    const res = await request.get('/api/health');
    return { status: res.status(), body: await res.json() };
  },

  async portfolio(request: APIRequestContext): Promise<Portfolio> {
    const res = await request.get('/api/portfolio');
    expect(res.status(), 'GET /api/portfolio should return 200').toBe(200);
    return (await res.json()) as Portfolio;
  },

  async history(request: APIRequestContext) {
    const res = await request.get('/api/portfolio/history');
    expect(res.status(), 'GET /api/portfolio/history should return 200').toBe(200);
    return (await res.json()) as { snapshots: { total_value: number; recorded_at: string }[] };
  },

  async watchlist(request: APIRequestContext) {
    const res = await request.get('/api/watchlist');
    expect(res.status(), 'GET /api/watchlist should return 200').toBe(200);
    return (await res.json()) as {
      watchlist: { ticker: string; added_at: string; price: number | null }[];
    };
  },

  /** Raw trade call — returns status and body without asserting, so error paths are testable. */
  async trade(
    request: APIRequestContext,
    body: { ticker: string; quantity: number; side: 'buy' | 'sell' },
  ) {
    const res = await request.post('/api/portfolio/trade', { data: body });
    return { status: res.status(), body: await res.json().catch(() => null) };
  },

  async addWatchlist(request: APIRequestContext, ticker: string) {
    const res = await request.post('/api/watchlist', { data: { ticker } });
    return { status: res.status(), body: await res.json().catch(() => null) };
  },

  async removeWatchlist(request: APIRequestContext, ticker: string) {
    const res = await request.delete(`/api/watchlist/${ticker}`);
    return { status: res.status() };
  },

  async chat(request: APIRequestContext, message: string) {
    const res = await request.post('/api/chat', { data: { message } });
    return { status: res.status(), body: await res.json().catch(() => null) };
  },
};

/**
 * Ensure a position exists so sell/heatmap scenarios have something to act on,
 * without depending on a previous spec having run.
 *
 * Retries through `quote_unavailable` (§8), which is a legitimate transient
 * state right after a ticker starts being tracked rather than a failure.
 */
export async function ensurePosition(
  request: APIRequestContext,
  ticker: string,
  quantity: number,
): Promise<Position> {
  const existing = (await api.portfolio(request)).positions.find((p) => p.ticker === ticker);
  if (existing && existing.quantity >= quantity) return existing;

  const needed = quantity - (existing?.quantity ?? 0);
  const deadline = Date.now() + 20_000;
  let last: { status: number; body: unknown } | null = null;

  while (Date.now() < deadline) {
    const result = await api.trade(request, { ticker, quantity: needed, side: 'buy' });
    if (result.status >= 200 && result.status < 300) {
      const position = (await api.portfolio(request)).positions.find((p) => p.ticker === ticker);
      if (position) return position;
    }
    last = result;
    const code = (result.body as ApiError | null)?.error?.code;
    // Only quote_unavailable is worth waiting out; anything else is a real failure.
    if (code !== 'quote_unavailable') break;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Could not open a ${quantity}-share position in ${ticker} for test setup. ` +
      `Last response: ${JSON.stringify(last)}`,
  );
}

// --- Streaming helpers ---

/**
 * Wait until a watchlist price cell changes value, proving the SSE stream is
 * actually delivering updates to the UI (not just that a number rendered once).
 */
export async function waitForPriceChange(
  page: Page,
  ticker: string,
  timeoutMs = 20_000,
): Promise<{ before: number; after: number }> {
  const locator = page.getByTestId(sel.watchlistPrice(ticker));
  await expect(locator).toBeVisible();

  const before = await numberFrom(locator);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = await numberFrom(locator);
    if (!Number.isNaN(current) && !Number.isNaN(before) && current !== before) {
      return { before, after: current };
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Price for ${ticker} never changed within ${timeoutMs}ms (stuck at ${before}). ` +
      `Expected live updates over SSE (§6).`,
  );
}

/**
 * Attach a raw EventSource probe to the page, independent of the app's own
 * client code. Used by the SSE resilience spec so reconnection can be observed
 * even if the app's connection indicator is missing or wrong — this separates
 * "the server/stream is broken" from "the UI indicator is broken".
 */
export async function installSseProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __sseProbe?: { events: number; opens: number; errors: number; source?: EventSource };
    };
    if (w.__sseProbe) return;

    const probe: { events: number; opens: number; errors: number; source?: EventSource } = {
      events: 0,
      opens: 0,
      errors: 0,
    };
    w.__sseProbe = probe;

    const source = new EventSource('/api/stream/prices');
    // Retain the reference on the probe. Without a live reference the
    // EventSource becomes eligible for garbage collection once its connection
    // drops, so it never performs its automatic retry and the probe silently
    // reports a reconnection failure that is really a harness bug.
    probe.source = source;

    source.onopen = () => { probe.opens += 1; };
    source.onmessage = () => { probe.events += 1; };
    source.onerror = () => { probe.errors += 1; };
  });
}

export async function readSseProbe(
  page: Page,
): Promise<{ events: number; opens: number; errors: number }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __sseProbe?: { events: number; opens: number; errors: number };
    };
    return w.__sseProbe ?? { events: 0, opens: 0, errors: 0 };
  });
}

/** Wait until the probe has seen at least `target` total events. */
export async function waitForSseEvents(
  page: Page,
  target: number,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = (await readSseProbe(page)).events;
    if (seen >= target) return seen;
    await page.waitForTimeout(200);
  }
  throw new Error(`SSE probe saw only ${seen} events, expected >= ${target} within ${timeoutMs}ms.`);
}

