/**
 * Portfolio metrics recomputed client-side from the live price map.
 *
 * `GET /api/portfolio` returns a valuation that was correct at request time.
 * Prices then tick twice a second, so the UI re-derives every price-dependent
 * figure locally using the formulas in PLAN §8 and only refetches when
 * *positions* change (a trade), not when prices do.
 */
import type { Portfolio, Position, PriceSnapshot } from "./types";

/** Live price for a ticker, or null when the cache has no quote yet. */
export function priceOf(prices: PriceSnapshot, ticker: string): number | null {
  const update = prices[ticker];
  return update ? update.price : null;
}

/**
 * §8: an unpriceable position falls back to `avg_cost`, which values it at
 * break-even rather than dropping it or showing it as worthless.
 */
export function livePosition(position: Position, prices: PriceSnapshot): Position {
  const live = priceOf(prices, position.ticker);
  const price = live ?? position.avg_cost;
  return {
    ...position,
    current_price: price,
    market_value: price * position.quantity,
    unrealized_pnl: (price - position.avg_cost) * position.quantity,
    change_percent: ((price - position.avg_cost) / position.avg_cost) * 100,
  };
}

export function livePortfolio(portfolio: Portfolio, prices: PriceSnapshot): Portfolio {
  const positions = portfolio.positions.map((position) => livePosition(position, prices));
  const invested = positions.reduce((sum, p) => sum + p.market_value, 0);
  const unrealized = positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);
  return {
    cash_balance: portfolio.cash_balance,
    positions,
    total_value: portfolio.cash_balance + invested,
    unrealized_pnl: unrealized,
  };
}

/**
 * §8: weight is measured against total value *including* cash, so an all-cash
 * portfolio reads 0% everywhere instead of dividing by zero.
 */
export function weightOf(position: Position, totalValue: number): number {
  if (!totalValue) return 0;
  return position.market_value / totalValue;
}

/** §12: heatmap tiles are green above zero, red below, neutral at exactly zero. */
export function pnlTone(pnl: number): "up" | "down" | "flat" {
  if (pnl > 0) return "up";
  if (pnl < 0) return "down";
  return "flat";
}

/**
 * §10: change since page load, anchored on the first streamed price for this
 * ticker. Null until that anchor exists.
 */
export function changeSinceLoad(
  current: number | undefined,
  anchor: number | undefined,
): number | null {
  if (current == null || anchor == null || !anchor) return null;
  return ((current - anchor) / anchor) * 100;
}

export const EMPTY_PORTFOLIO: Portfolio = {
  cash_balance: 0,
  total_value: 0,
  unrealized_pnl: 0,
  positions: [],
};
