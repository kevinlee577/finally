"use client";

import { Panel, PanelEmpty } from "./Panel";
import { pnlTone, weightOf } from "@/lib/derive";
import { fmtCompactMoney, fmtPct } from "@/lib/format";
import { squarify } from "@/lib/treemap";
import { useSize } from "@/lib/useSize";
import type { Position } from "@/lib/types";

interface PortfolioHeatmapProps {
  positions: Position[];
  totalValue: number;
  selected: string | null;
  onSelect: (ticker: string) => void;
}

/** Saturation tracks conviction: a 5% move is fully coloured, smaller ones fade. */
function tileColor(changePercent: number, tone: "up" | "down" | "flat"): string {
  if (tone === "flat") return "color-mix(in srgb, var(--color-faint) 22%, var(--color-panel))";
  const base = tone === "up" ? "var(--color-up)" : "var(--color-down)";
  const intensity = Math.min(Math.abs(changePercent) / 5, 1);
  const pct = Math.round(16 + intensity * 52);
  return `color-mix(in srgb, ${base} ${pct}%, var(--color-panel))`;
}

export function PortfolioHeatmap({
  positions,
  totalValue,
  selected,
  onSelect,
}: PortfolioHeatmapProps) {
  const { ref, size } = useSize<HTMLDivElement>({ width: 420, height: 200 });

  const tiles = squarify(
    positions.map((position) => ({ key: position.ticker, value: position.market_value })),
    size.width,
    size.height,
  );
  const byTicker = new Map(positions.map((position) => [position.ticker, position]));

  return (
    <Panel
      title="Allocation"
      meta="size = weight · colour = P&L"
      bodyClassName="p-0"
      active={Boolean(selected && byTicker.has(selected))}
      testId="heatmap-panel"
    >
      <div ref={ref} className="relative h-full w-full" data-testid="portfolio-heatmap">
        {positions.length === 0 ? (
          <div data-testid="heatmap-empty" className="h-full">
            <PanelEmpty>No positions yet. Buy something to fill this out.</PanelEmpty>
          </div>
        ) : (
          tiles.map((tile) => {
            const position = byTicker.get(tile.key);
            if (!position) return null;
            const tone = pnlTone(position.unrealized_pnl);
            const weight = weightOf(position, totalValue) * 100;
            const roomy = tile.width > 62 && tile.height > 40;
            const isSelected = selected === tile.key;

            return (
              <button
                key={tile.key}
                type="button"
                onClick={() => onSelect(tile.key)}
                data-testid={`heatmap-tile-${tile.key}`}
                data-tone={tone}
                // §12 makes "green above zero, red below, neutral at zero" an
                // assertable rule; a computed fill colour is not reliably
                // readable, so the sign is published directly.
                data-pnl-sign={tone === "up" ? "positive" : tone === "down" ? "negative" : "zero"}
                data-value={position.unrealized_pnl}
                title={`${tile.key} · ${fmtPct(position.change_percent)} · ${weight.toFixed(1)}% of portfolio`}
                className="absolute overflow-hidden text-left transition-[outline-color] outline-1 outline-offset-[-1px]"
                style={{
                  left: tile.x,
                  top: tile.y,
                  width: Math.max(tile.width - 1, 0),
                  height: Math.max(tile.height - 1, 0),
                  background: tileColor(position.change_percent, tone),
                  outlineColor: isSelected ? "var(--color-amber)" : "var(--color-edge)",
                }}
              >
                <span className="block px-1.5 pt-1 text-[11px] leading-none font-bold tracking-[0.04em] text-ink">
                  {tile.key}
                </span>
                {roomy ? (
                  <>
                    <span className="tnum block px-1.5 pt-1 text-[10px] leading-none text-ink/85">
                      {fmtPct(position.change_percent)}
                    </span>
                    <span className="tnum block px-1.5 pt-1 text-[10px] leading-none text-ink/60">
                      {fmtCompactMoney(position.market_value)}
                    </span>
                  </>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}
