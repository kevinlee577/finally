"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Panel } from "./Panel";
import { fmtMoney, fmtQty } from "@/lib/format";
import type { ChatAction, ChatTurn } from "@/lib/types";

interface ChatPanelProps {
  turns: ChatTurn[];
  pending: boolean;
  /** False when the backend reports `chat_enabled: false` (§5/§8). */
  enabled: boolean;
  disabledMessage: string;
  onSend: (text: string) => void;
}

const SUGGESTIONS = [
  "How is my portfolio doing?",
  "Buy 10 shares of NVDA",
  "Add PYPL to my watchlist",
];

/**
 * §9: `message` is what the model *intended* — it was written before execution
 * ran. This list is the only accurate record of what actually happened, so it
 * is rendered separately and never folded into the prose.
 */
function ActionRow({ action }: { action: ChatAction }) {
  const failed = action.status === "failed";
  const label =
    action.type === "trade"
      ? `${action.side === "buy" ? "Buy" : "Sell"} ${fmtQty(action.quantity)} ${action.ticker}`
      : action.type === "watchlist_add"
        ? `Add ${action.ticker} to watchlist`
        : `Remove ${action.ticker} from watchlist`;

  const detail =
    failed
      ? (action.error ?? "failed")
      : action.type === "trade" && action.fill_price != null
        ? `filled @ ${fmtMoney(action.fill_price)}`
        : "done";

  return (
    <li
      data-testid="chat-action"
      data-status={action.status}
      data-type={action.type}
      data-ticker={action.ticker}
      className={`flex items-baseline gap-2 border-l-2 py-1 pr-2 pl-2 text-[11px] ${
        failed ? "border-down bg-down/8 text-down" : "border-up bg-up/8 text-up"
      }`}
    >
      <span aria-hidden className="font-bold">
        {failed ? "×" : "✓"}
      </span>
      <span className="font-semibold text-ink">{label}</span>
      <span className="tnum ml-auto whitespace-nowrap">{detail}</span>
    </li>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <li className="flex justify-end" data-testid="chat-message" data-role="user">
        <p className="max-w-[85%] border border-blue/35 bg-blue/10 px-2.5 py-1.5 text-[12px] leading-snug text-ink">
          {turn.content}
        </p>
      </li>
    );
  }

  return (
    <li className="space-y-1.5" data-testid="chat-message" data-role="assistant">
      <div className="flex items-center gap-1.5">
        <span className="h-[9px] w-[2px] bg-amber" aria-hidden />
        <span className="text-[10px] font-semibold tracking-[0.1em] text-faint">FinAlly</span>
      </div>
      <p
        className={`text-[12px] leading-relaxed whitespace-pre-wrap ${
          turn.failed ? "text-down" : "text-ink/90"
        }`}
      >
        {turn.content}
      </p>
      {turn.actions && turn.actions.length > 0 ? (
        <ul className="space-y-px" data-testid="chat-actions">
          {turn.actions.map((action, index) => (
            <ActionRow key={`${action.type}-${action.ticker}-${index}`} action={action} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ChatPanel({ turns, pending, enabled, disabledMessage, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns, pending]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending || !enabled) return;
    onSend(text);
    setDraft("");
  }

  return (
    <Panel
      title="Assistant"
      meta={enabled ? "auto-executes trades" : "unavailable"}
      className="h-full"
      bodyClassName="flex flex-col"
      testId="chat-panel"
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto p-2.5"
        data-testid="chat-messages"
      >
        {turns.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-2">
            <p className="text-[12px] leading-relaxed text-dim">
              Ask about your positions, or tell FinAlly what to trade. Trades and watchlist changes
              run immediately — there is no confirmation step.
            </p>
            {enabled ? (
              <ul className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      className="border border-edge-strong bg-sunken px-2 py-1 text-[11px] text-dim transition hover:border-faint hover:text-ink"
                      onClick={() => onSend(suggestion)}
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-3">
            {turns.map((turn) => (
              <Turn key={turn.id} turn={turn} />
            ))}
            {pending ? (
              <li className="flex items-center gap-1.5" data-testid="chat-loading">
                <span className="text-[9px] font-semibold tracking-[0.16em] text-faint uppercase">
                  Thinking
                </span>
                {[0, 1, 2].map((index) => (
                  <span
                    key={index}
                    className="think-dot h-[3px] w-[3px] rounded-full bg-amber"
                    style={{ animationDelay: `${index * 160}ms` }}
                    aria-hidden
                  />
                ))}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {!enabled ? (
        <p
          role="note"
          data-testid="chat-disabled-notice"
          className="flex-none border-t border-amber/30 bg-amber/8 px-2.5 py-2 text-[11px] leading-relaxed text-amber"
        >
          {disabledMessage}
        </p>
      ) : null}

      <form onSubmit={submit} className="flex flex-none gap-1.5 border-t border-edge bg-sunken p-1.5">
        <label className="sr-only" htmlFor="chat-input">
          Message FinAlly
        </label>
        <input
          id="chat-input"
          data-testid="chat-input"
          className="field min-w-0 flex-1"
          placeholder={enabled ? "Ask or instruct…" : "Chat unavailable"}
          value={draft}
          disabled={!enabled || pending}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          data-testid="chat-send"
          className="btn btn-submit"
          disabled={!enabled || pending || draft.trim() === ""}
        >
          Send
        </button>
      </form>
    </Panel>
  );
}
