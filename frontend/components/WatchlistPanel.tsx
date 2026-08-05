"use client";

import { useState, type FormEvent } from "react";
import { Panel, PanelEmpty } from "./Panel";
import { Sparkline } from "./Sparkline";
import { changeSinceLoad } from "@/lib/derive";
import { fmtMoney, fmtPct, isValidTicker, normalizeTicker } from "@/lib/format";
import { useFlash } from "@/lib/useFlash";
import { SPARK_POINTS, type PricePoint } from "@/lib/usePriceStream";
import type { PriceSnapshot, WatchlistEntry } from "@/lib/types";

/** Symbol · last · change · trend · remove. */
const COLUMNS = "60px minmax(0,1fr) 50px 54px 14px";

interface WatchlistPanelProps {
  entries: WatchlistEntry[];
  prices: PriceSnapshot;
  firstSeen: Record<string, number>;
  history: Record<string, PricePoint[]>;
  selected: string | null;
  heldTickers: Set<string>;
  onSelect: (ticker: string) => void;
  /** Rejects with an ApiError whose message is shown inline. */
  onAdd: (ticker: string) => Promise<void>;
  onRemove: (ticker: string) => Promise<void>;
}

interface RowProps {
  entry: WatchlistEntry;
  price: number | null;
  changePct: number | null;
  points: number[];
  selected: boolean;
  held: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function WatchlistRow({
  entry,
  price,
  changePct,
  points,
  selected,
  held,
  onSelect,
  onRemove,
}: RowProps) {
  const flashRef = useFlash<HTMLLIElement>(price);
  const tone = changePct == null || changePct === 0 ? "flat" : changePct > 0 ? "up" : "down";
  const changeColor = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-faint";

  return (
    <li
      ref={flashRef}
      data-testid={`watchlist-row-${entry.ticker}`}
      data-selected={selected}
      data-held={held}
      className={`flash group relative border-b border-edge/60 ${
        selected ? "bg-raised" : "row-hover"
      }`}
    >
      {/* Stretched hit area: keeps the row keyboard-selectable without nesting
          the remove button inside another button. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className="absolute inset-0 z-0 h-full w-full cursor-pointer"
      >
        <span className="sr-only">
          Show {entry.ticker} chart{price == null ? "" : `, ${fmtMoney(price)}`}
        </span>
      </button>

      <div
        className="pointer-events-none relative z-[1] grid h-8 items-center gap-[5px] pr-1.5 pl-2.5"
        style={{
          gridTemplateColumns: COLUMNS,
          boxShadow: selected ? "inset 2px 0 0 var(--color-amber)" : undefined,
        }}
      >
        <span
          className="flex min-w-0 items-center gap-1 text-[12px] font-semibold tracking-[0.03em] text-ink"
          title={held ? `${entry.ticker} — you hold a position` : entry.ticker}
        >
          <span className="truncate">{entry.ticker}</span>
          {held ? (
            // A dot, not a badge: position detail belongs to the positions
            // table, and a badge crowds out the symbol it is annotating.
            <>
              <span
                data-testid={`watchlist-held-${entry.ticker}`}
                className="h-[3px] w-[3px] shrink-0 rounded-full bg-blue"
                aria-hidden
              />
              <span className="sr-only">position open</span>
            </>
          ) : null}
        </span>

        <span
          data-testid={`watchlist-price-${entry.ticker}`}
          data-value={price ?? ""}
          className="tnum truncate text-right text-[12px] text-ink"
        >
          {price == null ? <span className="text-faint">—</span> : fmtMoney(price)}
        </span>

        <span
          data-testid={`watchlist-change-pct-${entry.ticker}`}
          data-value={changePct ?? ""}
          className={`tnum text-right text-[11px] ${changeColor}`}
        >
          {changePct == null ? "—" : fmtPct(changePct)}
        </span>

        <span
          className="flex items-center justify-end"
          data-testid={`watchlist-sparkline-${entry.ticker}`}
        >
          <Sparkline points={points} width={54} tone={tone} label={entry.ticker} />
        </span>

        <button
          type="button"
          data-testid={`watchlist-remove-${entry.ticker}`}
          onClick={onRemove}
          title={`Remove ${entry.ticker} from watchlist`}
          className="pointer-events-auto relative z-[2] flex h-4 w-4 items-center justify-center text-[13px] leading-none text-faint opacity-0 transition group-hover:opacity-100 hover:text-down focus-visible:opacity-100"
        >
          <span aria-hidden>×</span>
          <span className="sr-only">Remove {entry.ticker} from watchlist</span>
        </button>
      </div>
    </li>
  );
}

export function WatchlistPanel({
  entries,
  prices,
  firstSeen,
  history,
  selected,
  heldTickers,
  onSelect,
  onAdd,
  onRemove,
}: WatchlistPanelProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function report(err: unknown, fallback: string) {
    setError(err instanceof Error ? err.message : fallback);
    setErrorCode(
      typeof err === "object" && err !== null && "code" in err ? String(err.code) : null,
    );
  }

  function clearError() {
    setError(null);
    setErrorCode(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ticker = normalizeTicker(draft);
    if (!ticker) return;
    if (!isValidTicker(ticker)) {
      setError("Tickers use letters, dots, and dashes only.");
      setErrorCode("invalid_ticker");
      return;
    }
    setBusy(true);
    clearError();
    try {
      await onAdd(ticker);
      setDraft("");
    } catch (err) {
      report(err, "Couldn't add that ticker.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(ticker: string) {
    clearError();
    try {
      await onRemove(ticker);
    } catch (err) {
      report(err, "Couldn't remove that ticker.");
    }
  }

  return (
    <Panel
      title="Watchlist"
      meta={`${entries.length} symbol${entries.length === 1 ? "" : "s"}`}
      bodyClassName="flex flex-col"
      testId="watchlist-panel"
    >
      <div
        className="grid flex-none gap-[5px] border-b border-edge bg-sunken py-1 pr-1.5 pl-2.5"
        style={{ gridTemplateColumns: COLUMNS }}
      >
        <span className="grid-head">Symbol</span>
        <span className="grid-head text-right">Last</span>
        {/* "Chg" runs from the first streamed price after page load — the feed
            carries no session-open reference (§10). */}
        <span className="grid-head text-right">Chg</span>
        <span className="grid-head text-right">Trend</span>
        <span />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="watchlist">
        {entries.length === 0 ? (
          <li data-testid="watchlist-empty">
            <PanelEmpty>Add a symbol below to start watching it.</PanelEmpty>
          </li>
        ) : (
          entries.map((entry) => {
            const streamed = prices[entry.ticker]?.price;
            // Fall back to the price REST handed us until the first frame lands.
            const price = streamed ?? entry.price ?? null;
            const points = (history[entry.ticker] ?? []).slice(-SPARK_POINTS).map((p) => p.price);
            return (
              <WatchlistRow
                key={entry.ticker}
                entry={entry}
                price={price}
                changePct={changeSinceLoad(streamed, firstSeen[entry.ticker])}
                points={points}
                selected={selected === entry.ticker}
                held={heldTickers.has(entry.ticker)}
                onSelect={() => onSelect(entry.ticker)}
                onRemove={() => void remove(entry.ticker)}
              />
            );
          })
        )}
      </ul>

      <form
        onSubmit={submit}
        className="flex flex-none items-center gap-1.5 border-t border-edge bg-sunken p-1.5"
      >
        <label className="sr-only" htmlFor="watchlist-add">
          Add a ticker to the watchlist
        </label>
        <input
          id="watchlist-add"
          data-testid="watchlist-add-input"
          className="field min-w-0 flex-1 uppercase"
          placeholder="ADD SYMBOL"
          value={draft}
          maxLength={12}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            clearError();
          }}
        />
        <button
          type="submit"
          data-testid="watchlist-add-submit"
          className="btn"
          disabled={busy || draft.trim() === ""}
        >
          Add
        </button>
      </form>

      {error ? (
        <p
          role="alert"
          data-testid="watchlist-error"
          data-error-code={errorCode ?? undefined}
          className="flex-none border-t border-down/30 bg-down/10 px-2.5 py-1.5 text-[11px] text-down"
        >
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
