"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Panel, PanelEmpty } from "./Panel";
import { fmtClock, fmtMoney, fmtSignedMoney } from "@/lib/format";
import type { Snapshot } from "@/lib/types";

interface PnlChartProps {
  snapshots: Snapshot[];
  /** Live total value, appended as the trailing point between 30s snapshots. */
  liveValue: number | null;
  /** The account's starting cash, drawn as the break-even line. */
  baseline: number;
}

const AXIS = { stroke: "var(--color-faint)", fontSize: 10, fontFamily: "var(--font-mono)" };

export function PnlChart({ snapshots, liveValue, baseline }: PnlChartProps) {
  const series = snapshots.map((snapshot) => ({
    label: fmtClock(snapshot.recorded_at),
    value: snapshot.total_value,
  }));
  if (liveValue != null) {
    series.push({ label: "now", value: liveValue });
  }

  const latest = series.length ? series[series.length - 1].value : null;
  const delta = latest == null ? null : latest - baseline;
  const stroke =
    delta == null || delta === 0
      ? "var(--color-blue)"
      : delta > 0
        ? "var(--color-up)"
        : "var(--color-down)";

  return (
    <Panel
      title="Portfolio value"
      meta={
        delta == null ? (
          "—"
        ) : (
          <span className={delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-faint"}>
            {fmtSignedMoney(delta)} vs. start
          </span>
        )
      }
      bodyClassName="p-1"
      testId="pnl-panel"
    >
      {/* Always mounted with the point count published, so "the chart has data"
          is checkable without reaching into the rendered SVG. */}
      <div className="h-full w-full" data-testid="pnl-chart" data-point-count={series.length}>
        {series.length < 2 ? (
          <PanelEmpty>Charting starts once a second snapshot lands.</PanelEmpty>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--color-edge)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS}
                axisLine={{ stroke: "var(--color-edge)" }}
                tickLine={false}
                minTickGap={44}
              />
              <YAxis
                domain={["dataMin - 20", "dataMax + 20"]}
                tickFormatter={(value: number) => fmtMoney(value)}
                tick={AXIS}
                axisLine={false}
                tickLine={false}
                width={66}
                orientation="right"
              />
              <ReferenceLine
                y={baseline}
                stroke="var(--color-edge-strong)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={stroke}
                strokeWidth={1.5}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Panel>
  );
}
