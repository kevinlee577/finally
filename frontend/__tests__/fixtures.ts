import type { PriceSnapshot, PriceUpdate, Position, WatchlistEntry } from "@/lib/types";

export function priceUpdate(
  ticker: string,
  price: number,
  previous = price,
  timestamp = 1_738_000_000,
): PriceUpdate {
  const change = price - previous;
  return {
    ticker,
    price,
    previous_price: previous,
    timestamp,
    change,
    change_percent: previous ? (change / previous) * 100 : 0,
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

export function snapshot(entries: Array<[string, number, number?]>): PriceSnapshot {
  const out: PriceSnapshot = {};
  for (const [ticker, price, previous] of entries) {
    out[ticker] = priceUpdate(ticker, price, previous ?? price);
  }
  return out;
}

export function watchlistEntry(ticker: string, price: number | null = null): WatchlistEntry {
  return { ticker, added_at: "2026-08-01T20:00:00.000Z", price };
}

/**
 * Builds a position whose price-dependent fields are internally consistent, so
 * a test that only cares about rendering doesn't have to compute them by hand.
 */
export function position(
  ticker: string,
  quantity: number,
  avgCost: number,
  currentPrice: number,
): Position {
  return {
    ticker,
    quantity,
    avg_cost: avgCost,
    current_price: currentPrice,
    market_value: currentPrice * quantity,
    unrealized_pnl: (currentPrice - avgCost) * quantity,
    change_percent: ((currentPrice - avgCost) / avgCost) * 100,
  };
}
