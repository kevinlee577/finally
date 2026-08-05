"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { Header } from "./Header";
import { MainChart } from "./MainChart";
import { PnlChart } from "./PnlChart";
import { PortfolioHeatmap } from "./PortfolioHeatmap";
import { PositionsTable } from "./PositionsTable";
import { TradeBar, type TradeStatus } from "./TradeBar";
import { WatchlistPanel } from "./WatchlistPanel";
import { ApiError, api } from "@/lib/api";
import { EMPTY_PORTFOLIO, livePortfolio } from "@/lib/derive";
import { fmtMoney, fmtQty, isValidTicker, normalizeTicker } from "@/lib/format";
import { usePriceStream } from "@/lib/usePriceStream";
import type { ChatTurn, Portfolio, Snapshot, TradeSide, WatchlistEntry } from "@/lib/types";

const STARTING_CASH = 10_000;
/** Snapshots land every 30s server-side; poll at half that to stay current. */
const HISTORY_POLL_MS = 15_000;
/** Safety net in case positions change through a path the UI didn't initiate. */
const PORTFOLIO_POLL_MS = 30_000;

const CHAT_DISABLED_COPY =
  "AI chat is not configured — set OPENROUTER_API_KEY to enable it.";

let turnCounter = 0;
function nextTurnId(): string {
  turnCounter += 1;
  return `turn-${turnCounter}`;
}

export function Terminal() {
  const { prices, firstSeen, history, status, forget, reconnect } = usePriceStream();

  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio>(EMPTY_PORTFOLIO);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const [tradeTicker, setTradeTicker] = useState("");
  const [tradeQty, setTradeQty] = useState("");
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeStatus, setTradeStatus] = useState<TradeStatus | null>(null);

  const [chatOpen, setChatOpen] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [chatPending, setChatPending] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  // Selection follows the first watchlist entry only until the user picks one.
  const userPicked = useRef(false);

  const refreshPortfolio = useCallback(async () => {
    try {
      setPortfolio(await api.portfolio());
    } catch {
      // A failed refresh leaves the last good figures on screen; the SSE feed
      // keeps them repriced, and the next poll will reconcile positions.
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setSnapshots(await api.history());
    } catch {
      /* keep the existing series */
    }
  }, []);

  const refreshWatchlist = useCallback(async () => {
    try {
      setWatchlist(await api.watchlist());
    } catch {
      /* keep the existing list */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api.health();
        setChatEnabled(health.chat_enabled);
      } catch {
        // Assume chat works; a 503 on the first send corrects this.
      }
    })();
    void refreshWatchlist();
    void refreshPortfolio();
    void refreshHistory();
  }, [refreshHistory, refreshPortfolio, refreshWatchlist]);

  useEffect(() => {
    const history = setInterval(() => void refreshHistory(), HISTORY_POLL_MS);
    const positions = setInterval(() => void refreshPortfolio(), PORTFOLIO_POLL_MS);
    return () => {
      clearInterval(history);
      clearInterval(positions);
    };
  }, [refreshHistory, refreshPortfolio]);

  useEffect(() => {
    if (userPicked.current) return;
    if (!selected && watchlist.length > 0) setSelected(watchlist[0].ticker);
  }, [watchlist, selected]);

  const live = useMemo(() => livePortfolio(portfolio, prices), [portfolio, prices]);
  const heldTickers = useMemo(
    () => new Set(live.positions.map((position) => position.ticker)),
    [live.positions],
  );

  const baseline = snapshots.length > 0 ? snapshots[0].total_value : STARTING_CASH;
  const returnPct = baseline ? ((live.total_value - baseline) / baseline) * 100 : null;

  const selectTicker = useCallback((ticker: string) => {
    userPicked.current = true;
    setSelected(ticker);
    setTradeTicker(ticker);
    setTradeStatus(null);
  }, []);

  // --- Watchlist -----------------------------------------------------------

  const addTicker = useCallback(
    async (ticker: string) => {
      const entry = await api.addTicker(ticker);
      setWatchlist((prev) =>
        prev.some((row) => row.ticker === entry.ticker) ? prev : [...prev, entry],
      );
    },
    [],
  );

  const removeTicker = useCallback(
    async (ticker: string) => {
      await api.removeTicker(ticker);
      // §6: a removal is not promptly visible over SSE — the stream only drops
      // the ticker on the next frame some *other* ticker triggers, and possibly
      // never. The REST response is the authoritative signal, so local state is
      // updated from it directly.
      setWatchlist((prev) => prev.filter((row) => row.ticker !== ticker));
      // A held ticker keeps streaming even once unwatchlisted, so its
      // accumulated series stays useful; only drop it when nothing holds it.
      if (!heldTickers.has(ticker)) forget(ticker);
      setSelected((current) => {
        if (current !== ticker) return current;
        const next = watchlist.find((row) => row.ticker !== ticker);
        return next ? next.ticker : null;
      });
    },
    [forget, heldTickers, watchlist],
  );

  // --- Trading -------------------------------------------------------------

  const submitTrade = useCallback(
    async (side: TradeSide) => {
      const ticker = normalizeTicker(tradeTicker);
      const quantity = Number(tradeQty);

      if (!isValidTicker(ticker)) {
        setTradeStatus({
          tone: "error",
          text: "Tickers use letters, dots, and dashes only.",
          code: "invalid_ticker",
        });
        return;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setTradeStatus({
          tone: "error",
          text: "Enter a quantity greater than zero.",
          code: "validation_error",
        });
        return;
      }

      setTradeBusy(true);
      setTradeStatus(null);
      try {
        const result = await api.trade({ ticker, quantity, side });
        setTradeStatus({
          tone: "ok",
          text: `${side === "buy" ? "Bought" : "Sold"} ${fmtQty(quantity)} ${ticker} · cash ${fmtMoney(result.cash_balance)}`,
        });
        setTradeQty("");
        await Promise.all([refreshPortfolio(), refreshHistory(), refreshWatchlist()]);
      } catch (error) {
        setTradeStatus({
          tone: "error",
          text: error instanceof Error ? error.message : "Trade failed.",
          code: error instanceof ApiError ? error.code : undefined,
        });
      } finally {
        setTradeBusy(false);
      }
    },
    [refreshHistory, refreshPortfolio, refreshWatchlist, tradeQty, tradeTicker],
  );

  // --- Chat ----------------------------------------------------------------

  const sendChat = useCallback(
    async (text: string) => {
      setTurns((prev) => [...prev, { id: nextTurnId(), role: "user", content: text }]);
      setChatPending(true);
      try {
        const response = await api.chat(text);
        setTurns((prev) => [
          ...prev,
          {
            id: nextTurnId(),
            role: "assistant",
            content: response.message,
            actions: response.actions,
          },
        ]);
        // The assistant executes trades and watchlist edits without asking, so
        // every turn can have changed the account underneath us.
        if (response.actions && response.actions.length > 0) {
          await Promise.all([refreshPortfolio(), refreshWatchlist(), refreshHistory()]);
        }
      } catch (error) {
        const apiError = error instanceof ApiError ? error : null;
        if (apiError?.code === "chat_unavailable") setChatEnabled(false);
        setTurns((prev) => [
          ...prev,
          {
            id: nextTurnId(),
            role: "assistant",
            content: apiError?.message ?? "Sorry, I had trouble processing that — please try again.",
            failed: true,
          },
        ]);
      } finally {
        setChatPending(false);
      }
    },
    [refreshHistory, refreshPortfolio, refreshWatchlist],
  );

  // --- Derived view data ---------------------------------------------------

  const selectedPrice = selected ? (prices[selected]?.price ?? null) : null;
  const selectedChange =
    selected && prices[selected] && firstSeen[selected]
      ? ((prices[selected].price - firstSeen[selected]) / firstSeen[selected]) * 100
      : null;

  const tradeTickerNormalized = normalizeTicker(tradeTicker);
  const tradeLivePrice = prices[tradeTickerNormalized]?.price ?? null;
  const heldQuantity =
    live.positions.find((position) => position.ticker === tradeTickerNormalized)?.quantity ?? null;

  return (
    <div className="flex h-screen flex-col bg-void">
      <Header
        totalValue={live.total_value}
        cashBalance={live.cash_balance}
        unrealizedPnl={live.unrealized_pnl}
        returnPct={returnPct}
        status={status}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
        onReconnect={reconnect}
      />

      <main
        className="grid min-h-0 flex-1 gap-px overflow-auto bg-edge p-px lg:overflow-hidden"
        style={{
          gridTemplateColumns: chatOpen
            ? "minmax(272px, 300px) minmax(0, 1fr) minmax(300px, 340px)"
            : "minmax(272px, 300px) minmax(0, 1fr)",
        }}
      >
        <WatchlistPanel
          entries={watchlist}
          prices={prices}
          firstSeen={firstSeen}
          history={history}
          selected={selected}
          heldTickers={heldTickers}
          onSelect={selectTicker}
          onAdd={addTicker}
          onRemove={removeTicker}
        />

        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] gap-px">
          <MainChart
            ticker={selected}
            points={selected ? (history[selected] ?? []) : []}
            price={selectedPrice}
            changePct={selectedChange}
          />
          <div className="grid min-h-0 grid-cols-2 gap-px">
            <PortfolioHeatmap
              positions={live.positions}
              totalValue={live.total_value}
              selected={selected}
              onSelect={selectTicker}
            />
            <PnlChart
              snapshots={snapshots}
              liveValue={live.total_value}
              baseline={baseline}
            />
          </div>
          <PositionsTable
            positions={live.positions}
            selected={selected}
            onSelect={selectTicker}
          />
        </div>

        {chatOpen ? (
          <div id="chat-panel" className="min-h-0 min-w-0">
            <ChatPanel
              turns={turns}
              pending={chatPending}
              enabled={chatEnabled}
              disabledMessage={CHAT_DISABLED_COPY}
              onSend={(text) => void sendChat(text)}
            />
          </div>
        ) : null}
      </main>

      <TradeBar
        ticker={tradeTicker}
        quantity={tradeQty}
        onTickerChange={(value) => {
          setTradeTicker(value);
          setTradeStatus(null);
        }}
        onQuantityChange={setTradeQty}
        livePrice={tradeLivePrice}
        heldQuantity={heldQuantity}
        cashBalance={live.cash_balance}
        busy={tradeBusy}
        status={tradeStatus}
        onSubmit={(side) => void submitTrade(side)}
      />
    </div>
  );
}
