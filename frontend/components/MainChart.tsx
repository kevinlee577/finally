"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Panel, PanelEmpty } from "./Panel";
import { fmtMoney, fmtPct } from "@/lib/format";
import { useFlash } from "@/lib/useFlash";
import type { PricePoint } from "@/lib/usePriceStream";

interface MainChartProps {
  ticker: string | null;
  points: PricePoint[];
  price: number | null;
  /** Change since page load, in percent. */
  changePct: number | null;
}

const AXIS = { stroke: "var(--color-faint)", fontSize: 10, fontFamily: "var(--font-mono)" };

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function MainChart({ ticker, points, price, changePct }: MainChartProps) {
  const headRef = useFlash<HTMLDivElement>(price);
  const tone = changePct == null || changePct === 0 ? "flat" : changePct > 0 ? "up" : "down";
  const stroke =
    tone === "up" ? "var(--color-up)" : tone === "down" ? "var(--color-down)" : "var(--color-blue)";

  const low = points.length ? Math.min(...points.map((p) => p.price)) : null;
  const high = points.length ? Math.max(...points.map((p) => p.price)) : null;

  return (
    <Panel
      title={ticker ? `Chart · ${ticker}` : "Chart"}
      active={Boolean(ticker)}
      meta={
        low != null && high != null
          ? `session range ${fmtMoney(low)} – ${fmtMoney(high)}`
          : "since page load"
      }
      bodyClassName="flex flex-col"
      testId="main-chart-panel"
    >
      {!ticker ? (
        <PanelEmpty>Pick a symbol in the watchlist to chart it.</PanelEmpty>
      ) : (
        <>
          <div
            ref={headRef}
            className="flash flex flex-none items-baseline gap-3 border-b border-edge px-3 py-2"
          >
            <span className="text-[15px] font-bold tracking-[0.03em] text-ink">{ticker}</span>
            <span className="tnum text-[22px] leading-none font-medium text-ink">
              {price == null ? "—" : fmtMoney(price)}
            </span>
            <span
              className={`tnum text-[12px] ${
                tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-faint"
              }`}
            >
              {changePct == null ? "—" : fmtPct(changePct)}
            </span>
            <span className="ml-auto text-[10px] tracking-[0.1em] text-faint uppercase">
              {points.length} ticks
            </span>
          </div>

          <div className="min-h-0 flex-1 p-1" data-testid="main-chart">
            {points.length < 2 ? (
              <PanelEmpty>Collecting ticks for {ticker}…</PanelEmpty>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-edge)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={clock}
                    tick={AXIS}
                    axisLine={{ stroke: "var(--color-edge)" }}
                    tickLine={false}
                    minTickGap={48}
                  />
                  <YAxis
                    dataKey="price"
                    domain={["dataMin - 0.15", "dataMax + 0.15"]}
                    tickFormatter={(value: number) => value.toFixed(2)}
                    tick={AXIS}
                    axisLine={false}
                    tickLine={false}
                    width={54}
                    orientation="right"
                  />
                  <Area
                    type="linear"
                    dataKey="price"
                    stroke={stroke}
                    strokeWidth={1.5}
                    fill="url(#chart-fill)"
                    isAnimationActive={false}
                    dot={false}
                    activeDot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
