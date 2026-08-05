/**
 * LLM_MOCK trigger phrases (PLAN.md §12 "Mock LLM fixtures").
 *
 * MIRRORS: backend/app/llm/mock.py — `MOCK_FIXTURES`.
 * Keep this file in sync with that table; it is the source of truth.
 *
 * Matching rules implemented by `match_fixture()` in mock.py:
 *   - The incoming message is lowercased and whitespace-collapsed.
 *   - Fixtures are tried IN TABLE ORDER; the first trigger found as a
 *     SUBSTRING wins. Failure-path triggers are listed first because they are
 *     supersets of the happy-path ones.
 *   - No match falls through to DEFAULT_FIXTURE: an analysis reply with no
 *     actions.
 *
 * Substring matching makes exact trigger text load-bearing. For example
 * "buy 100000 aapl" does NOT match the "buy 1000000 aapl" fixture, and does
 * not match "buy 10 aapl" either (the following characters are "0000 aapl",
 * not " aapl"), so it would silently fall through to the default fixture and
 * execute no trades. Use the constants below rather than retyping phrases.
 */

export const MOCK_TRIGGERS = {
  /** No trigger matches -> DEFAULT_FIXTURE: analysis reply, no actions. */
  analysisOnly: 'how is my portfolio doing?',

  /** trades: [AAPL buy 10] -> executes. */
  buyAapl: 'buy 10 aapl',

  /** trades: [MSFT buy 5] -> executes. */
  buyMsft: 'buy 5 msft',

  /** trades: [AAPL sell 5] -> executes when a position of >=5 exists. */
  sellAapl: 'sell 5 aapl',

  /** watchlist_changes: [PYPL add] -> executes. */
  addWatchlist: 'add pypl',

  /** watchlist_changes: [NFLX remove] -> executes. */
  removeWatchlist: 'remove nflx',

  /**
   * trades: [AAPL buy 1000000] -> fails with insufficient cash against the
   * $10k balance. Exercises §9's core contract: `message` narrates intent
   * while `actions` reports the real outcome.
   */
  failingBuy: 'buy 1000000 aapl',

  /** trades: [TSLA sell 9999] -> fails with insufficient_shares / no_position. */
  failingSell: 'sell 9999 tsla',

  /** Emits invalid JSON -> §9 "Malformed LLM Output" fallback, no actions. */
  malformed: 'break the parser',

  /**
   * trades: [AAPL buy 2, NVDA buy 1] then watchlist_changes: [PYPL add].
   * Verifies §9 step 7 ordering: all trades before all watchlist changes.
   */
  rebalance: 'rebalance my portfolio',

  /**
   * trades: [AAPL buy 1, GOOGL buy 999999 (fails), MSFT buy 1].
   * Verifies §7: a mid-batch failure does not abort the remaining trades.
   */
  mixedBatch: 'mixed batch',

  /** trades: [AAPL buy 0.5] -> fractional quantity path (§7). */
  fractional: 'fractional',
} as const;

/** Quantities/tickers the fixtures above are expected to act on. */
export const FIXTURE_EXPECTATIONS = {
  buyAaplQuantity: 10,
  buyMsftQuantity: 5,
  sellAaplQuantity: 5,
  fractionalQuantity: 0.5,
  watchlistTicker: 'PYPL',
  removeTicker: 'NFLX',
  /** mixedBatch: index 0 executes, index 1 fails, index 2 executes. */
  mixedBatchStatuses: ['executed', 'failed', 'executed'] as const,
  /** rebalance: two trades then one watchlist_add, in that order. */
  rebalanceTypes: ['trade', 'trade', 'watchlist_add'] as const,
} as const;

/** The §9 generic fallback text is asserted loosely — only that a reply exists. */
export const MALFORMED_FALLBACK_HINT = 'trouble';
