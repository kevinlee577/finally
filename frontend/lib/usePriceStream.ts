"use client";

/**
 * Live price feed over SSE (PLAN §6).
 *
 * Each frame is a *full snapshot* of every tracked ticker, so the price map is
 * replaced wholesale rather than merged — that is also how a ticker disappears
 * from the stream after it stops being tracked. Frames carry no `event:` name,
 * so they arrive as default `message` events.
 *
 * The stream has no session-open or prior-close reference price. "Change since
 * page load" and the sparklines are therefore both derived here, from the first
 * frame in which each ticker appeared. Both reset on reload, and a ticker added
 * mid-session anchors at the first frame that includes it (§10).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState, PriceSnapshot } from "./types";

export interface PricePoint {
  /** Unix seconds, straight from the frame. */
  t: number;
  price: number;
}

/** ~5 minutes of 500ms ticks. Bounds memory on a page left open all day. */
const MAX_POINTS = 600;
/** Trailing points a sparkline draws. */
export const SPARK_POINTS = 48;

export interface PriceStream {
  prices: PriceSnapshot;
  /** First price seen per ticker since page load — the % change anchor. */
  firstSeen: Record<string, number>;
  /** Per-ticker point buffer accumulated from the stream. */
  history: Record<string, PricePoint[]>;
  status: ConnectionState;
  /** Drops locally accumulated state for a ticker removed via REST. */
  forget: (ticker: string) => void;
  /**
   * Tears down the current stream and subscribes again.
   *
   * Only reachable by explicit user action, and only from `disconnected`.
   * EventSource retries transient failures itself; it gives up permanently on a
   * *fatal* error — a non-200 or a wrong `Content-Type` on the endpoint, which
   * is what a misconfigured proxy in front of the app produces. Without this,
   * that state is a dead end until the page is reloaded. Deliberately not an
   * automatic retry loop: against a genuinely misconfigured endpoint, silent
   * retries would hammer it and hide the fault behind an amber indicator.
   */
  reconnect: () => void;
}

export function usePriceStream(url = "/api/stream/prices"): PriceStream {
  const [prices, setPrices] = useState<PriceSnapshot>({});
  const [firstSeen, setFirstSeen] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<Record<string, PricePoint[]>>({});
  // Yellow until the first successful open: the feed is not live yet.
  const [status, setStatus] = useState<ConnectionState>("reconnecting");
  // Bumped to force the subscribe effect to tear down and re-run.
  const [generation, setGeneration] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);

  const forget = useCallback((ticker: string) => {
    setPrices((prev) => {
      if (!(ticker in prev)) return prev;
      const next = { ...prev };
      delete next[ticker];
      return next;
    });
    setFirstSeen((prev) => {
      if (!(ticker in prev)) return prev;
      const next = { ...prev };
      delete next[ticker];
      return next;
    });
    setHistory((prev) => {
      if (!(ticker in prev)) return prev;
      const next = { ...prev };
      delete next[ticker];
      return next;
    });
  }, []);

  const reconnect = useCallback(() => {
    // Show the attempt immediately; the effect below does the actual work.
    setStatus("reconnecting");
    setGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setStatus("disconnected");
      return;
    }

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setStatus("connected");

    source.onmessage = (event: MessageEvent<string>) => {
      let snapshot: PriceSnapshot;
      try {
        snapshot = JSON.parse(event.data) as PriceSnapshot;
      } catch {
        return; // A malformed frame is skipped; the next one supersedes it.
      }
      if (!snapshot || typeof snapshot !== "object") return;

      setStatus("connected");
      setPrices(snapshot);

      setFirstSeen((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [ticker, update] of Object.entries(snapshot)) {
          if (!(ticker in next)) {
            next[ticker] = update.price;
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      setHistory((prev) => {
        const next: Record<string, PricePoint[]> = { ...prev };
        for (const [ticker, update] of Object.entries(snapshot)) {
          const series = next[ticker] ?? [];
          const last = series[series.length - 1];
          // The stream re-emits unchanged tickers on every frame; only append
          // when this ticker actually moved, so a quiet ticker's sparkline
          // stays a short flat line instead of a long one.
          if (last && last.t === update.timestamp) continue;
          const appended = [...series, { t: update.timestamp, price: update.price }];
          next[ticker] =
            appended.length > MAX_POINTS ? appended.slice(appended.length - MAX_POINTS) : appended;
        }
        return next;
      });
    };

    source.onerror = () => {
      // EventSource reconnects on its own; CLOSED means it gave up.
      setStatus(source.readyState === 2 ? "disconnected" : "reconnecting");
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [url, generation]);

  return { prices, firstSeen, history, status, forget, reconnect };
}
