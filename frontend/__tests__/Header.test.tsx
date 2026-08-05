import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "@/components/Header";
import type { ConnectionState } from "@/lib/types";

function setup(overrides: Partial<Parameters<typeof Header>[0]> = {}) {
  const props = {
    totalValue: 10_120.35,
    cashBalance: 8450,
    unrealizedPnl: 120.35,
    returnPct: 1.2035 as number | null,
    status: "connected" as ConnectionState,
    chatOpen: true,
    onToggleChat: vi.fn(),
    onReconnect: vi.fn(),
    ...overrides,
  };
  const view = render(<Header {...props} />);
  return { ...view, props };
}

describe("portfolio figures", () => {
  it("renders total value, cash, P&L, and return", () => {
    setup();

    expect(screen.getByTestId("total-value")).toHaveTextContent("10,120.35");
    expect(screen.getByTestId("cash-balance")).toHaveTextContent("8,450.00");
    expect(screen.getByTestId("unrealized-pnl")).toHaveTextContent("+120.35");
    expect(screen.getByTestId("return-pct")).toHaveTextContent("+1.20%");
  });

  it("publishes raw numbers for consumers that shouldn't parse formatting", () => {
    setup();
    expect(screen.getByTestId("total-value")).toHaveAttribute("data-value", "10120.35");
    expect(screen.getByTestId("cash-balance")).toHaveAttribute("data-value", "8450");
  });

  it("colours P&L by sign", () => {
    const { rerender, props } = setup();
    expect(screen.getByTestId("unrealized-pnl").className).toContain("text-up");

    rerender(<Header {...props} unrealizedPnl={-45.2} />);
    expect(screen.getByTestId("unrealized-pnl")).toHaveTextContent("−45.20");
    expect(screen.getByTestId("unrealized-pnl").className).toContain("text-down");
  });

  it("shows an em dash for return before any history has loaded", () => {
    setup({ returnPct: null });
    expect(screen.getByTestId("return-pct")).toHaveTextContent("—");
  });
});

describe("connection status", () => {
  it.each([
    ["connected", "Live"],
    ["reconnecting", "Reconnecting"],
    ["disconnected", "Disconnected"],
  ] as const)("shows %s as %s", (status, label) => {
    setup({ status });
    const indicator = screen.getByTestId("connection-status");
    expect(indicator).toHaveAttribute("data-state", status);
    expect(indicator).toHaveTextContent(label);
  });
});

describe("reconnect", () => {
  it("offers a way out only once the feed has given up", () => {
    setup({ status: "disconnected" });
    expect(screen.getByTestId("reconnect-button")).toBeInTheDocument();
  });

  it.each(["connected", "reconnecting"] as const)(
    "stays hidden while %s, so it can't race the browser's own retry",
    (status) => {
      setup({ status });
      expect(screen.queryByTestId("reconnect-button")).not.toBeInTheDocument();
    },
  );

  it("re-subscribes when clicked", async () => {
    const user = userEvent.setup();
    const { props } = setup({ status: "disconnected" });

    await user.click(screen.getByTestId("reconnect-button"));
    expect(props.onReconnect).toHaveBeenCalledOnce();
  });
});

describe("assistant toggle", () => {
  it("labels the control by what clicking it will do", () => {
    const { rerender, props } = setup({ chatOpen: true });
    expect(screen.getByRole("button", { name: /hide assistant/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    rerender(<Header {...props} chatOpen={false} />);
    expect(screen.getByRole("button", { name: /show assistant/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("calls back when toggled", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByRole("button", { name: /hide assistant/i }));
    expect(props.onToggleChat).toHaveBeenCalledOnce();
  });
});
