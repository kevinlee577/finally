/**
 * Wire contracts shared with the backend. Every shape here is defined in
 * planning/PLAN.md — §6 (SSE), §8 (REST), §9 (chat).
 */

/** One ticker's entry in an SSE frame. Matches `PriceUpdate.to_dict()` (§6). */
export interface PriceUpdate {
  ticker: string;
  price: number;
  previous_price: number;
  /** Unix seconds — SSE only. REST timestamps are RFC 3339 strings. */
  timestamp: number;
  change: number;
  change_percent: number;
  direction: "up" | "down" | "flat";
}

/** An SSE frame is a full snapshot of every tracked ticker, keyed by symbol. */
export type PriceSnapshot = Record<string, PriceUpdate>;

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export interface WatchlistEntry {
  ticker: string;
  added_at: string;
  /** null until the market data source has produced a first quote. */
  price: number | null;
}

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

export interface Snapshot {
  total_value: number;
  recorded_at: string;
}

export type TradeSide = "buy" | "sell";

export interface TradeRequest {
  ticker: string;
  quantity: number;
  side: TradeSide;
}

/** §8: successful trades return the updated position and cash balance. */
export interface TradeResult {
  cash_balance: number;
  position: Position | null;
}

export interface Health {
  status: string;
  chat_enabled: boolean;
}

/** §9 response envelope — server-generated outcomes, not the LLM's proposal. */
export type ChatAction =
  | {
      type: "trade";
      ticker: string;
      side: TradeSide;
      quantity: number;
      status: "executed" | "failed";
      fill_price?: number;
      error?: string;
    }
  | {
      type: "watchlist_add" | "watchlist_remove";
      ticker: string;
      status: "executed" | "failed";
      error?: string;
    };

export interface ChatResponse {
  message: string;
  actions?: ChatAction[];
}

/** A rendered chat turn. `actions` is only ever set on assistant turns. */
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
  /** Set when the turn itself failed (transport/503), rendered as a notice. */
  failed?: boolean;
}
