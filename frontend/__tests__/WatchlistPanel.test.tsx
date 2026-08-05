import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { ApiError } from "@/lib/api";
import type { PricePoint } from "@/lib/usePriceStream";
import { snapshot, watchlistEntry } from "./fixtures";

function setup(overrides: Partial<Parameters<typeof WatchlistPanel>[0]> = {}) {
  const props = {
    entries: [watchlistEntry("AAPL", 190), watchlistEntry("GOOGL", 175)],
    prices: snapshot([["AAPL", 191.2, 190], ["GOOGL", 174.5, 175]]),
    firstSeen: { AAPL: 190, GOOGL: 175 },
    history: {} as Record<string, PricePoint[]>,
    selected: "AAPL" as string | null,
    heldTickers: new Set<string>(),
    onSelect: vi.fn(),
    onAdd: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const view = render(<WatchlistPanel {...props} />);
  return { ...view, props };
}

describe("rendering", () => {
  it("shows each symbol with its live price and change since page load", () => {
    setup();

    expect(screen.getByTestId("watchlist-row-AAPL")).toBeInTheDocument();
    expect(screen.getByTestId("watchlist-price-AAPL")).toHaveTextContent("191.20");
    // (191.20 - 190) / 190 = +0.63%
    expect(screen.getByTestId("watchlist-change-pct-AAPL")).toHaveTextContent("+0.63%");
    expect(screen.getByTestId("watchlist-change-pct-GOOGL")).toHaveTextContent("−0.29%");
  });

  it("publishes raw values alongside the formatted ones", () => {
    setup();
    expect(screen.getByTestId("watchlist-price-AAPL")).toHaveAttribute("data-value", "191.2");
  });

  it("falls back to the REST price until the first frame arrives", () => {
    setup({ prices: {}, firstSeen: {} });
    expect(screen.getByTestId("watchlist-price-AAPL")).toHaveTextContent("190.00");
    expect(screen.getByTestId("watchlist-change-pct-AAPL")).toHaveTextContent("—");
  });

  it("shows an em dash when a newly added ticker has no quote at all", () => {
    setup({ entries: [watchlistEntry("PYPL", null)], prices: {}, firstSeen: {} });
    expect(screen.getByTestId("watchlist-price-PYPL")).toHaveTextContent("—");
  });

  it("marks the selected row and marks tickers with an open position", () => {
    setup({ heldTickers: new Set(["GOOGL"]) });

    expect(screen.getByTestId("watchlist-row-AAPL")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("watchlist-row-GOOGL")).toHaveAttribute("data-selected", "false");
    expect(screen.getByTestId("watchlist-held-GOOGL")).toBeInTheDocument();
    expect(screen.queryByTestId("watchlist-held-AAPL")).not.toBeInTheDocument();
  });

  it("invites the user to add a symbol when the list is empty", () => {
    setup({ entries: [] });
    expect(screen.getByTestId("watchlist-empty")).toHaveTextContent(/add a symbol/i);
  });

  it("draws a sparkline once there are at least two points", () => {
    const { rerender, props } = setup({
      history: { AAPL: [{ t: 1, price: 190 }] },
    });
    expect(screen.getByTestId("watchlist-sparkline-AAPL").querySelector("polyline")).toBeNull();

    rerender(
      <WatchlistPanel
        {...props}
        history={{ AAPL: [{ t: 1, price: 190 }, { t: 2, price: 191 }, { t: 3, price: 192 }] }}
      />,
    );
    expect(screen.getByTestId("watchlist-sparkline-AAPL").querySelector("polyline")).not.toBeNull();
  });
});

describe("price flash (§10)", () => {
  it("flashes green when the price ticks up", () => {
    const { rerender, props } = setup();
    const row = screen.getByTestId("watchlist-row-AAPL");
    expect(row.className).not.toContain("flash-up");

    rerender(<WatchlistPanel {...props} prices={snapshot([["AAPL", 192.5, 191.2]])} />);
    expect(row.className).toContain("flash-up");
    expect(row.className).not.toContain("flash-down");
  });

  it("flashes red when the price ticks down", () => {
    const { rerender, props } = setup();
    const row = screen.getByTestId("watchlist-row-AAPL");

    rerender(<WatchlistPanel {...props} prices={snapshot([["AAPL", 189, 191.2]])} />);
    expect(row.className).toContain("flash-down");
  });

  it("does not flash when the price is unchanged", () => {
    const { rerender, props } = setup();
    const row = screen.getByTestId("watchlist-row-AAPL");

    rerender(<WatchlistPanel {...props} prices={snapshot([["AAPL", 191.2, 191.2]])} />);
    expect(row.className).not.toContain("flash-up");
    expect(row.className).not.toContain("flash-down");
  });

  it("does not flash on the very first price it sees", () => {
    setup({ prices: {}, firstSeen: {}, entries: [watchlistEntry("PYPL", 60)] });
    const row = screen.getByTestId("watchlist-row-PYPL");
    expect(row.className).not.toContain("flash-up");
  });

  it("switches direction when an up tick is followed by a down tick", () => {
    const { rerender, props } = setup();
    const row = screen.getByTestId("watchlist-row-AAPL");

    rerender(<WatchlistPanel {...props} prices={snapshot([["AAPL", 192.5]])} />);
    expect(row.className).toContain("flash-up");

    rerender(<WatchlistPanel {...props} prices={snapshot([["AAPL", 191]])} />);
    expect(row.className).toContain("flash-down");
    expect(row.className).not.toContain("flash-up");
  });
});

describe("add", () => {
  it("normalizes the ticker before handing it to the API", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.type(screen.getByTestId("watchlist-add-input"), " pypl ");
    await user.click(screen.getByTestId("watchlist-add-submit"));

    expect(props.onAdd).toHaveBeenCalledWith("PYPL");
  });

  it("clears the field after a successful add", async () => {
    const user = userEvent.setup();
    setup();

    const input = screen.getByTestId("watchlist-add-input");
    await user.type(input, "pypl");
    await user.click(screen.getByTestId("watchlist-add-submit"));

    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("rejects a syntactically invalid ticker without calling the API", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.type(screen.getByTestId("watchlist-add-input"), "12X");
    await user.click(screen.getByTestId("watchlist-add-submit"));

    expect(props.onAdd).not.toHaveBeenCalled();
    expect(await screen.findByTestId("watchlist-error")).toHaveAttribute(
      "data-error-code",
      "invalid_ticker",
    );
  });

  it("surfaces a duplicate_ticker rejection with its code and message", async () => {
    const user = userEvent.setup();
    setup({
      onAdd: vi.fn().mockRejectedValue(new ApiError("duplicate_ticker", "AAPL is already on your watchlist.", 409)),
    });

    await user.type(screen.getByTestId("watchlist-add-input"), "aapl");
    await user.click(screen.getByTestId("watchlist-add-submit"));

    const error = await screen.findByTestId("watchlist-error");
    expect(error).toHaveTextContent("AAPL is already on your watchlist.");
    expect(error).toHaveAttribute("data-error-code", "duplicate_ticker");
  });

  it("keeps the submit button disabled until something is typed", async () => {
    const user = userEvent.setup();
    setup();

    const submit = screen.getByTestId("watchlist-add-submit");
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId("watchlist-add-input"), "p");
    expect(submit).toBeEnabled();
  });

  it("clears a previous error as soon as the user edits the field", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByTestId("watchlist-add-input"), "12X");
    await user.click(screen.getByTestId("watchlist-add-submit"));
    expect(await screen.findByTestId("watchlist-error")).toBeInTheDocument();

    await user.type(screen.getByTestId("watchlist-add-input"), "Y");
    expect(screen.queryByTestId("watchlist-error")).not.toBeInTheDocument();
  });
});

describe("remove", () => {
  it("asks the API to remove the row's ticker", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByTestId("watchlist-remove-GOOGL"));
    expect(props.onRemove).toHaveBeenCalledWith("GOOGL");
  });

  it("does not select the row when the remove button is clicked", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByTestId("watchlist-remove-GOOGL"));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("surfaces a not_watchlisted rejection", async () => {
    const user = userEvent.setup();
    setup({
      onRemove: vi.fn().mockRejectedValue(new ApiError("not_watchlisted", "GOOGL isn't on your watchlist.", 404)),
    });

    await user.click(screen.getByTestId("watchlist-remove-GOOGL"));
    expect(await screen.findByTestId("watchlist-error")).toHaveAttribute(
      "data-error-code",
      "not_watchlisted",
    );
  });
});

describe("selection", () => {
  it("selects a ticker when its row is clicked", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByRole("button", { name: /show googl chart/i }));
    expect(props.onSelect).toHaveBeenCalledWith("GOOGL");
  });
});
