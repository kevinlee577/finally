import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PositionsTable } from "@/components/PositionsTable";
import { position } from "./fixtures";

function setup(overrides: Partial<Parameters<typeof PositionsTable>[0]> = {}) {
  const props = {
    positions: [position("AAPL", 10, 188, 191.2), position("TSLA", 3.5, 250, 240)],
    selected: "AAPL" as string | null,
    onSelect: vi.fn(),
    ...overrides,
  };
  const view = render(<PositionsTable {...props} />);
  return { ...view, props };
}

describe("rendering", () => {
  it("shows every column from §10 for each position", () => {
    setup();

    expect(screen.getByTestId("position-row-AAPL")).toHaveTextContent("AAPL");
    expect(screen.getByTestId("position-quantity-AAPL")).toHaveTextContent("10");
    expect(screen.getByTestId("position-avg-cost-AAPL")).toHaveTextContent("188.00");
    expect(screen.getByTestId("position-price-AAPL")).toHaveTextContent("191.20");
    expect(screen.getByTestId("position-market-value-AAPL")).toHaveTextContent("1,912.00");
    expect(screen.getByTestId("position-pnl-AAPL")).toHaveTextContent("+32.00");
    expect(screen.getByTestId("position-change-pct-AAPL")).toHaveTextContent("+1.70%");
  });

  it("renders a loss with its sign and colour", () => {
    setup();

    expect(screen.getByTestId("position-pnl-TSLA")).toHaveTextContent("−35.00");
    expect(screen.getByTestId("position-change-pct-TSLA")).toHaveTextContent("−4.00%");
    expect(screen.getByTestId("position-pnl-TSLA").className).toContain("text-down");
    expect(screen.getByTestId("position-pnl-AAPL").className).toContain("text-up");
  });

  it("keeps fractional quantities intact", () => {
    setup();
    expect(screen.getByTestId("position-quantity-TSLA")).toHaveTextContent("3.5");
    expect(screen.getByTestId("position-quantity-TSLA")).toHaveAttribute("data-value", "3.5");
  });

  it("publishes raw values on every numeric cell", () => {
    setup();
    expect(screen.getByTestId("position-price-AAPL")).toHaveAttribute("data-value", "191.2");
    // Unrounded, so consumers get full precision rather than the display value.
    const pnl = screen.getByTestId("position-pnl-AAPL").getAttribute("data-value");
    expect(Number(pnl)).toBeCloseTo(32, 6);
  });

  it("summarizes total invested value in the panel header", () => {
    setup();
    // 1,912.00 + 840.00
    expect(screen.getByTestId("positions-panel")).toHaveTextContent("2,752.00 invested");
  });

  it("shows a placeholder instead of an empty table when flat", () => {
    setup({ positions: [] });

    expect(screen.queryByTestId("positions-table")).not.toBeInTheDocument();
    expect(screen.getByTestId("positions-empty")).toHaveTextContent(/no open positions/i);
  });
});

describe("selection", () => {
  it("selects the ticker when a row is clicked", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByTestId("position-row-TSLA"));
    expect(props.onSelect).toHaveBeenCalledWith("TSLA");
  });
});
