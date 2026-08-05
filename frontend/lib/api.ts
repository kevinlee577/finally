/**
 * Typed client for the same-origin `/api/*` REST surface (PLAN §8).
 *
 * Every non-2xx body is `{"error": {"code", "message"}}`, so all failures are
 * surfaced as an `ApiError` carrying the machine-readable code — callers switch
 * on `err.code` (`quote_unavailable`, `insufficient_cash`, …) rather than
 * pattern-matching prose.
 */
import type {
  ChatResponse,
  Health,
  Portfolio,
  Snapshot,
  TradeRequest,
  TradeResult,
  WatchlistEntry,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body
        ? { "Content-Type": "application/json", ...init?.headers }
        : init?.headers,
    });
  } catch {
    throw new ApiError("network_error", "Can't reach the server.", 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const envelope = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      envelope?.code ?? "internal_error",
      envelope?.message ?? `Request failed (${response.status}).`,
      response.status,
    );
  }

  return body as T;
}

export const api = {
  health: () => request<Health>("/api/health"),

  portfolio: () => request<Portfolio>("/api/portfolio"),

  history: () =>
    request<{ snapshots: Snapshot[] }>("/api/portfolio/history").then((r) => r.snapshots),

  trade: (trade: TradeRequest) =>
    request<TradeResult>("/api/portfolio/trade", {
      method: "POST",
      body: JSON.stringify(trade),
    }),

  watchlist: () =>
    request<{ watchlist: WatchlistEntry[] }>("/api/watchlist").then((r) => r.watchlist),

  addTicker: (ticker: string) =>
    request<WatchlistEntry>("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ ticker }),
    }),

  /** Returns 204 with no body; resolves when the row is gone. */
  removeTicker: (ticker: string) =>
    request<void>(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: "DELETE" }),

  chat: (message: string) =>
    request<ChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
};
