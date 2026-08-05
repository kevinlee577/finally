import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PortfolioHeatmap } from "@/components/PortfolioHeatmap";
import { position } from "./fixtures";

function setup(overrides: Partial<Parameters<typeof PortfolioHeatmap>[0]> = {}) {
  const props = {
    positions: [
      position("AAPL", 10, 188, 191.2), // gain
      position("TSLA", 3.5, 250, 240), // loss
      position("MSFT", 2, 415, 415), // break-even
    ],
    totalValue: 10_000,
    selected: "AAPL" as string | null,
    onSelect: vi.fn(),
    ...overrides,
  };
  const view = render(<PortfolioHeatmap {...props} />);
  return { ...view, props };
}

describe("rendering", () => {
  it("draws one tile per position", () => {
    setup();
    expect(screen.getByTestId("heatmap-tile-AAPL")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-tile-TSLA")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-tile-MSFT")).toBeInTheDocument();
  });

  it("classifies tiles by P&L sign, using the §12 thresholds", () => {
    setup();
    expect(screen.getByTestId("heatmap-tile-AAPL")).toHaveAttribute("data-pnl-sign", "positive");
    expect(screen.getByTestId("heatmap-tile-TSLA")).toHaveAttribute("data-pnl-sign", "negative");
    expect(screen.getByTestId("heatmap-tile-MSFT")).toHaveAttribute("data-pnl-sign", "zero");
  });

  it("describes each tile with its change and portfolio weight", () => {
    setup();
    // 1,912.00 of a 10,000.00 book is 19.1%.
    expect(screen.getByTestId("heatmap-tile-AAPL")).toHaveAttribute(
      "title",
      expect.stringContaining("19.1%"),
    );
  });

  it("sizes tiles by market value, largest first", () => {
    setup();
    const area = (testId: string) => {
      const tile = screen.getByTestId(testId);
      return parseFloat(tile.style.width) * parseFloat(tile.style.height);
    };
    // AAPL 1,912 > TSLA 840 > MSFT 830
    expect(area("heatmap-tile-AAPL")).toBeGreaterThan(area("heatmap-tile-TSLA"));
    expect(area("heatmap-tile-TSLA")).toBeGreaterThan(area("heatmap-tile-MSFT"));
  });

  it("shows the §8 placeholder rather than a blank panel when flat", () => {
    setup({ positions: [] });
    expect(screen.getByTestId("heatmap-empty")).toHaveTextContent(/no positions yet/i);
    expect(screen.queryByTestId("heatmap-tile-AAPL")).not.toBeInTheDocument();
  });

  it("renders without dividing by zero on an all-cash portfolio", () => {
    setup({ positions: [], totalValue: 0 });
    expect(screen.getByTestId("portfolio-heatmap")).toBeInTheDocument();
  });
});

describe("selection", () => {
  it("selects the ticker when a tile is clicked", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByTestId("heatmap-tile-TSLA"));
    expect(props.onSelect).toHaveBeenCalledWith("TSLA");
  });

  it("outlines the selected tile in the accent colour", () => {
    setup();
    expect(screen.getByTestId("heatmap-tile-AAPL").style.outlineColor).toBe("var(--color-amber)");
    expect(screen.getByTestId("heatmap-tile-TSLA").style.outlineColor).toBe("var(--color-edge)");
  });
});
