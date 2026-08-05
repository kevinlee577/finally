import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TradeBar } from "@/components/TradeBar";

function setup(overrides: Partial<Parameters<typeof TradeBar>[0]> = {}) {
  const props = {
    ticker: "AAPL",
    quantity: "10",
    onTickerChange: vi.fn(),
    onQuantityChange: vi.fn(),
    livePrice: 191.2 as number | null,
    heldQuantity: null as number | null,
    cashBalance: 8450,
    busy: false,
    status: null,
    onSubmit: vi.fn(),
    ...overrides,
  };
  const view = render(<TradeBar {...props} />);
  return { ...view, props };
}

describe("order entry", () => {
  it("submits a buy and a sell with the chosen side", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByTestId("trade-buy-button"));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("buy");

    await user.click(screen.getByTestId("trade-sell-button"));
    expect(props.onSubmit).toHaveBeenLastCalledWith("sell");
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
  });

  it("treats Enter in the form as a buy, so selling stays deliberate", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.type(screen.getByTestId("trade-quantity-input"), "{Enter}");
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("buy");
  });

  it("forwards keystrokes in the quantity field", async () => {
    const user = userEvent.setup();
    const { props } = setup({ quantity: "" });

    await user.type(screen.getByTestId("trade-quantity-input"), "7");
    expect(props.onQuantityChange).toHaveBeenCalledWith("7");
  });

  it("treats a fractional quantity as a valid order (§10)", () => {
    setup({ quantity: "2.5" });

    const input = screen.getByTestId("trade-quantity-input");
    expect(input).toHaveValue("2.5");
    // A number input with an integer step would reject this silently.
    expect(input).not.toHaveAttribute("type", "number");
    expect(screen.getByTestId("trade-buy-button")).toBeEnabled();
  });
});

describe("readiness", () => {
  it.each([
    ["an empty ticker", { ticker: "" }],
    ["an empty quantity", { quantity: "" }],
    ["a zero quantity", { quantity: "0" }],
    ["a negative quantity", { quantity: "-5" }],
    ["a non-numeric quantity", { quantity: "abc" }],
    ["an in-flight request", { busy: true }],
  ])("disables both sides for %s", (_label, override) => {
    setup(override);
    expect(screen.getByTestId("trade-buy-button")).toBeDisabled();
    expect(screen.getByTestId("trade-sell-button")).toBeDisabled();
  });

  it("enables both sides for a valid order", () => {
    setup();
    expect(screen.getByTestId("trade-buy-button")).toBeEnabled();
    expect(screen.getByTestId("trade-sell-button")).toBeEnabled();
  });
});

describe("estimate", () => {
  it("shows the cost estimate and the quote it used", () => {
    setup();
    expect(screen.getByTestId("trade-estimate")).toHaveTextContent("Est. 1,912.00");
    expect(screen.getByTestId("trade-estimate")).toHaveTextContent("@ 191.20");
  });

  it("still shows the quote when no quantity is entered yet", () => {
    setup({ quantity: "" });
    const estimate = screen.getByTestId("trade-estimate");
    expect(estimate).toHaveTextContent("@ 191.20");
    expect(estimate).not.toHaveTextContent(/no quote/i);
  });

  it("says a symbol is unquoted only when there is genuinely no price", () => {
    setup({ ticker: "ZZZZ", livePrice: null });
    expect(screen.getByTestId("trade-estimate")).toHaveTextContent("No quote yet for ZZZZ");
  });

  it("shows nothing before a ticker is typed", () => {
    setup({ ticker: "", livePrice: null });
    expect(screen.getByTestId("trade-estimate")).toBeEmptyDOMElement();
  });
});

describe("holdings", () => {
  it("offers to fill the exact held quantity when a position is open", async () => {
    const user = userEvent.setup();
    const { props } = setup({ heldQuantity: 10.5 });

    const fill = screen.getByRole("button", { name: /all 10.5/i });
    await user.click(fill);
    expect(props.onQuantityChange).toHaveBeenCalledWith("10.5");
  });

  it("hides the fill control when flat", () => {
    setup({ heldQuantity: null });
    expect(screen.queryByRole("button", { name: /^all/i })).not.toBeInTheDocument();
  });
});

describe("status", () => {
  it("reports a fill as a status, with no error element present", () => {
    setup({ status: { tone: "ok", text: "Bought 10 AAPL · cash 6,538.00" } });

    expect(screen.getByTestId("trade-status")).toHaveTextContent("Bought 10 AAPL");
    expect(screen.queryByTestId("trade-error")).not.toBeInTheDocument();
  });

  it("reports a rejection with its §8 error code", () => {
    setup({
      status: { tone: "error", text: "Buy exceeds cash balance.", code: "insufficient_cash" },
    });

    const error = screen.getByTestId("trade-error");
    expect(error).toHaveTextContent("Buy exceeds cash balance.");
    expect(error).toHaveAttribute("data-error-code", "insufficient_cash");
    expect(screen.queryByTestId("trade-status")).not.toBeInTheDocument();
  });

  it("always shows buying power", () => {
    setup();
    expect(screen.getByTestId("buying-power")).toHaveTextContent("8,450.00");
    expect(screen.getByTestId("buying-power")).toHaveAttribute("data-value", "8450");
  });
});
