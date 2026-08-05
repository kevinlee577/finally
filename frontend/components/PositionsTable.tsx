"use client";

import { Panel, PanelEmpty } from "./Panel";
import { fmtMoney, fmtPct, fmtQty, fmtSignedMoney } from "@/lib/format";
import { useFlash } from "@/lib/useFlash";
import type { Position } from "@/lib/types";

interface PositionsTableProps {
  positions: Position[];
  selected: string | null;
  onSelect: (ticker: string) => void;
}

function PositionRow({
  position,
  selected,
  onSelect,
}: {
  position: Position;
  selected: boolean;
  onSelect: () => void;
}) {
  // Scoped to the price cell rather than the whole row: a full-width wash on
  // every 500ms tick, across every row at once, drowns out the P&L colouring
  // that the table exists to show.
  const ref = useFlash<HTMLTableCellElement>(position.current_price);
  const tone =
    position.unrealized_pnl > 0 ? "text-up" : position.unrealized_pnl < 0 ? "text-down" : "text-faint";

  return (
    <tr
      data-testid={`position-row-${position.ticker}`}
      onClick={onSelect}
      className={`cursor-pointer border-b border-edge/60 ${selected ? "bg-raised" : "row-hover"}`}
    >
      <th
        scope="row"
        className="py-1.5 pr-2 pl-2.5 text-left text-[12px] font-semibold tracking-[0.04em] text-ink"
        style={{ boxShadow: selected ? "inset 2px 0 0 var(--color-amber)" : undefined }}
      >
        {position.ticker}
      </th>
      <td
        data-testid={`position-quantity-${position.ticker}`}
        data-value={position.quantity}
        className="tnum px-2 py-1.5 text-right text-[12px] text-dim"
      >
        {fmtQty(position.quantity)}
      </td>
      <td
        data-testid={`position-avg-cost-${position.ticker}`}
        data-value={position.avg_cost}
        className="tnum px-2 py-1.5 text-right text-[12px] text-dim"
      >
        {fmtMoney(position.avg_cost)}
      </td>
      <td
        ref={ref}
        data-testid={`position-price-${position.ticker}`}
        data-value={position.current_price}
        className="flash tnum px-2 py-1.5 text-right text-[12px] text-ink"
      >
        {fmtMoney(position.current_price)}
      </td>
      <td
        data-testid={`position-market-value-${position.ticker}`}
        data-value={position.market_value}
        className="tnum px-2 py-1.5 text-right text-[12px] text-ink"
      >
        {fmtMoney(position.market_value)}
      </td>
      <td
        data-testid={`position-pnl-${position.ticker}`}
        data-value={position.unrealized_pnl}
        className={`tnum px-2 py-1.5 text-right text-[12px] ${tone}`}
      >
        {fmtSignedMoney(position.unrealized_pnl)}
      </td>
      <td
        data-testid={`position-change-pct-${position.ticker}`}
        data-value={position.change_percent}
        className={`tnum py-1.5 pr-2.5 pl-2 text-right text-[12px] ${tone}`}
      >
        {fmtPct(position.change_percent)}
      </td>
    </tr>
  );
}

export function PositionsTable({ positions, selected, onSelect }: PositionsTableProps) {
  const invested = positions.reduce((sum, position) => sum + position.market_value, 0);

  return (
    <Panel
      title="Positions"
      meta={positions.length ? `${fmtMoney(invested)} invested` : "flat"}
      bodyClassName="p-0"
      testId="positions-panel"
    >
      {positions.length === 0 ? (
        <div data-testid="positions-empty" className="h-full">
          <PanelEmpty>No open positions. Use the trade bar below to buy.</PanelEmpty>
        </div>
      ) : (
        <table className="w-full border-collapse" data-testid="positions-table">
          <caption className="sr-only">Open positions with cost basis and unrealized P&L</caption>
          <thead className="sticky top-0 z-[1] bg-sunken">
            <tr className="border-b border-edge">
              <th scope="col" className="grid-head py-1 pr-2 pl-2.5 text-left">
                Symbol
              </th>
              <th scope="col" className="grid-head px-2 py-1 text-right">
                Qty
              </th>
              <th scope="col" className="grid-head px-2 py-1 text-right">
                Avg cost
              </th>
              <th scope="col" className="grid-head px-2 py-1 text-right">
                Last
              </th>
              <th scope="col" className="grid-head px-2 py-1 text-right">
                Value
              </th>
              <th scope="col" className="grid-head px-2 py-1 text-right">
                P&L
              </th>
              <th scope="col" className="grid-head py-1 pr-2.5 pl-2 text-right">
                Chg
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <PositionRow
                key={position.ticker}
                position={position}
                selected={selected === position.ticker}
                onSelect={() => onSelect(position.ticker)}
              />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
