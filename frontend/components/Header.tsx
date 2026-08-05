"use client";

import { fmtMoney, fmtPct, fmtSignedMoney } from "@/lib/format";
import { useFlash } from "@/lib/useFlash";
import type { ConnectionState } from "@/lib/types";

interface HeaderProps {
  totalValue: number;
  cashBalance: number;
  unrealizedPnl: number;
  /** Return since the $10,000 starting line, in percent. */
  returnPct: number | null;
  status: ConnectionState;
  chatOpen: boolean;
  onToggleChat: () => void;
  /** Re-subscribes to the price feed. Offered only once it has given up. */
  onReconnect: () => void;
}

const STATUS_COPY: Record<ConnectionState, { label: string; color: string }> = {
  connected: { label: "Live", color: "var(--color-up)" },
  reconnecting: { label: "Reconnecting", color: "var(--color-amber)" },
  disconnected: { label: "Disconnected", color: "var(--color-down)" },
};

function Stat({
  label,
  value,
  raw,
  testId,
  tone = "ink",
  emphasis = false,
}: {
  label: string;
  value: string;
  /** Unformatted number, so consumers never have to parse "$8,450.00". */
  raw?: number | null;
  testId?: string;
  tone?: "ink" | "up" | "down" | "dim";
  emphasis?: boolean;
}) {
  const color =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "dim"
          ? "text-dim"
          : "text-ink";
  return (
    <div className="flex flex-col justify-center border-l border-edge px-4">
      <span className="grid-head">{label}</span>
      <span
        data-testid={testId}
        data-value={raw ?? undefined}
        className={`tnum leading-tight ${color} ${emphasis ? "text-[17px] font-medium" : "text-[13px]"}`}
      >
        {value}
      </span>
    </div>
  );
}

export function Header({
  totalValue,
  cashBalance,
  unrealizedPnl,
  returnPct,
  status,
  chatOpen,
  onToggleChat,
  onReconnect,
}: HeaderProps) {
  const totalRef = useFlash<HTMLDivElement>(totalValue);
  const pnlTone = unrealizedPnl > 0 ? "up" : unrealizedPnl < 0 ? "down" : "dim";
  const { label, color } = STATUS_COPY[status];

  return (
    <header className="flex h-14 flex-none items-stretch border-b border-edge bg-panel">
      <div className="flex items-center gap-2.5 pr-4 pl-4">
        <span className="h-5 w-[3px] bg-amber" aria-hidden />
        <div className="leading-none">
          <div className="text-[19px] font-bold tracking-[-0.02em] text-ink">
            Fin<span className="text-amber">Ally</span>
          </div>
          <div className="mt-[3px] text-[8px] font-semibold tracking-[0.22em] text-faint uppercase">
            Trading Workstation
          </div>
        </div>
      </div>

      <div ref={totalRef} className="flash flex">
        <Stat
          label="Total value"
          value={fmtMoney(totalValue)}
          raw={totalValue}
          testId="total-value"
          emphasis
        />
      </div>
      <Stat
        label="Cash"
        value={fmtMoney(cashBalance)}
        raw={cashBalance}
        testId="cash-balance"
        tone="dim"
      />
      <Stat
        label="Unrealized P&L"
        value={fmtSignedMoney(unrealizedPnl)}
        raw={unrealizedPnl}
        testId="unrealized-pnl"
        tone={pnlTone}
      />
      <Stat
        label="Return"
        value={returnPct == null ? "—" : fmtPct(returnPct)}
        raw={returnPct}
        testId="return-pct"
        tone={returnPct == null ? "dim" : returnPct > 0 ? "up" : returnPct < 0 ? "down" : "dim"}
      />

      <div className="ml-auto flex items-center gap-4 border-l border-edge px-4">
        <div
          className="flex items-center gap-2"
          title={`Price feed: ${label}`}
          data-testid="connection-status"
          data-state={status}
        >
          <span
            data-testid="connection-dot"
            data-status={status}
            className={`h-[7px] w-[7px] rounded-full ${status === "connected" ? "dot-pulse" : ""}`}
            style={{ background: color, boxShadow: `0 0 6px ${color}` }}
            aria-hidden
          />
          <span className="text-[10px] font-semibold tracking-[0.14em] text-dim uppercase">
            {label}
          </span>
          <span className="sr-only" role="status">
            Price feed {label}
          </span>
        </div>

        {/* Only offered once EventSource has given up for good. While it is
            still retrying on its own, a second stream would just race it. */}
        {status === "disconnected" ? (
          <button
            type="button"
            data-testid="reconnect-button"
            // Amber, so it reads as the action to take next to a red dot rather
            // than as another piece of header furniture. Amber is the accent
            // for attention throughout; red and green stay reserved for money.
            className="btn btn-alert h-[22px] px-2.5"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={onToggleChat}
          aria-expanded={chatOpen}
          aria-controls="chat-panel"
        >
          {chatOpen ? "Hide assistant" : "Show assistant"}
        </button>
      </div>
    </header>
  );
}
