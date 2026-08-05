"use client";

import type { FormEvent } from "react";
import { fmtMoney, fmtQty } from "@/lib/format";
import type { TradeSide } from "@/lib/types";

export interface TradeStatus {
  tone: "ok" | "error";
  text: string;
  /** The §8 error code behind a failure, published for assertions. */
  code?: string;
}

interface TradeBarProps {
  ticker: string;
  quantity: string;
  onTickerChange: (value: string) => void;
  onQuantityChange: (value: string) => void;
  /** Live price for the typed ticker, used for the estimate. Null if unquoted. */
  livePrice: number | null;
  /** Held quantity for the typed ticker, or null when flat. */
  heldQuantity: number | null;
  cashBalance: number;
  busy: boolean;
  status: TradeStatus | null;
  onSubmit: (side: TradeSide) => void;
}

export function TradeBar({
  ticker,
  quantity,
  onTickerChange,
  onQuantityChange,
  livePrice,
  heldQuantity,
  cashBalance,
  busy,
  status,
  onSubmit,
}: TradeBarProps) {
  const parsedQty = Number(quantity);
  const qtyValid = quantity.trim() !== "" && Number.isFinite(parsedQty) && parsedQty > 0;
  const ready = ticker.trim() !== "" && qtyValid && !busy;
  const estimate = qtyValid && livePrice != null ? parsedQty * livePrice : null;

  function handleSubmit(event: FormEvent) {
    // Enter in either field is a buy; selling always takes a deliberate click.
    event.preventDefault();
    if (ready) onSubmit("buy");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex h-11 flex-none items-center gap-2 border-t border-edge bg-panel px-3"
      data-testid="trade-bar"
    >
      <span className="flex items-center gap-2 pr-1 text-[10px] font-semibold tracking-[0.16em] text-dim uppercase">
        <span className="h-3 w-[2px] bg-amber" aria-hidden />
        Order
      </span>

      <label className="sr-only" htmlFor="trade-ticker">
        Ticker
      </label>
      <input
        id="trade-ticker"
        data-testid="trade-ticker-input"
        className="field w-28 uppercase"
        placeholder="SYMBOL"
        value={ticker}
        maxLength={12}
        autoComplete="off"
        onChange={(event) => onTickerChange(event.target.value)}
      />

      <label className="sr-only" htmlFor="trade-quantity">
        Quantity
      </label>
      <input
        id="trade-quantity"
        data-testid="trade-quantity-input"
        className="field w-28 text-right"
        placeholder="QTY"
        inputMode="decimal"
        // Fractional shares are supported end to end (§7), so no integer step.
        value={quantity}
        autoComplete="off"
        onChange={(event) => onQuantityChange(event.target.value)}
      />

      {/* Buy is the form's submit button, which is what makes Enter in either
          field place a buy. Its click is handled by the form's onSubmit — an
          onClick here as well would fire the order twice. */}
      <button type="submit" data-testid="trade-buy-button" className="btn btn-buy" disabled={!ready}>
        Buy
      </button>
      <button
        type="button"
        data-testid="trade-sell-button"
        className="btn btn-sell"
        disabled={!ready}
        onClick={() => onSubmit("sell")}
      >
        Sell
      </button>

      {heldQuantity != null && heldQuantity > 0 ? (
        <button
          type="button"
          className="btn"
          onClick={() => onQuantityChange(fmtQty(heldQuantity))}
          title={`Fill the quantity with your full ${fmtQty(heldQuantity)} share holding`}
        >
          All {fmtQty(heldQuantity)}
        </button>
      ) : null}

      {/* Quote and estimate are separate facts: an empty quantity field means
          there is no estimate to show, never that the symbol is unquoted. */}
      <div className="tnum ml-2 text-[11px] text-faint" data-testid="trade-estimate">
        {!ticker.trim() ? null : livePrice == null ? (
          <span>No quote yet for {ticker.trim().toUpperCase()}</span>
        ) : (
          <>
            {estimate != null ? (
              <>
                <span className="text-dim">Est.</span> {fmtMoney(estimate)}{" "}
              </>
            ) : null}
            <span>@ {fmtMoney(livePrice)}</span>
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-4">
        {status ? (
          <p
            role="status"
            data-testid={status.tone === "error" ? "trade-error" : "trade-status"}
            data-error-code={status.code}
            className={`text-[11px] ${status.tone === "error" ? "text-down" : "text-up"}`}
          >
            {status.text}
          </p>
        ) : null}
        <span
          className="tnum text-[11px] text-faint"
          data-testid="buying-power"
          data-value={cashBalance}
        >
          <span className="text-dim">Buying power</span> {fmtMoney(cashBalance)}
        </span>
      </div>
    </form>
  );
}
