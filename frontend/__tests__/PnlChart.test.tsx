import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PnlChart } from "@/components/PnlChart";
import type { Snapshot } from "@/lib/types";

const SNAPSHOTS: Snapshot[] = [
  { total_value: 10_000, recorded_at: "2026-08-01T20:00:00.000Z" },
  { total_value: 10_060, recorded_at: "2026-08-01T20:00:30.000Z" },
  { total_value: 10_120.35, recorded_at: "2026-08-01T20:01:00.000Z" },
];

function setup(overrides: Partial<Parameters<typeof PnlChart>[0]> = {}) {
  const props = {
    snapshots: SNAPSHOTS,
    liveValue: 10_140 as number | null,
    baseline: 10_000,
    ...overrides,
  };
  return { ...render(<PnlChart {...props} />), props };
}

describe("rendering", () => {
  it("publishes the point count, including the trailing live value", () => {
    setup();
    expect(screen.getByTestId("pnl-chart")).toHaveAttribute("data-point-count", "4");
  });

  it("plots only the snapshots when there is no live value yet", () => {
    setup({ liveValue: null });
    expect(screen.getByTestId("pnl-chart")).toHaveAttribute("data-point-count", "3");
  });

  it("stays mounted with a placeholder before a second point exists", () => {
    setup({ snapshots: [], liveValue: null });

    const chart = screen.getByTestId("pnl-chart");
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveAttribute("data-point-count", "0");
    expect(chart).toHaveTextContent(/charting starts/i);
  });

  it("reports the gain against the starting line", () => {
    setup();
    expect(screen.getByTestId("pnl-panel")).toHaveTextContent("+140.00 vs. start");
  });

  it("reports a loss against the starting line", () => {
    setup({
      snapshots: [
        { total_value: 10_000, recorded_at: "2026-08-01T20:00:00.000Z" },
        { total_value: 9_820, recorded_at: "2026-08-01T20:00:30.000Z" },
      ],
      liveValue: 9_820,
    });
    expect(screen.getByTestId("pnl-panel")).toHaveTextContent("−180.00 vs. start");
  });
});
