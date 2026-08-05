import { describe, expect, it } from "vitest";
import {
  changeSinceLoad,
  livePortfolio,
  livePosition,
  pnlTone,
  priceOf,
  weightOf,
} from "@/lib/derive";
import { position, snapshot } from "./fixtures";

describe("livePosition", () => {
  it("reprices market value, P&L, and percent change from the live quote", () => {
    const held = position("AAPL", 10, 188, 188);
    const repriced = livePosition(held, snapshot([["AAPL", 191.2]]));

    expect(repriced.current_price).toBe(191.2);
    expect(repriced.market_value).toBeCloseTo(1912, 6);
    expect(repriced.unrealized_pnl).toBeCloseTo(32, 6);
    expect(repriced.change_percent).toBeCloseTo(1.7021, 3);
  });

  it("values an unquoted position at cost rather than dropping it (§8)", () => {
    const held = position("PYPL", 4, 60, 60);
    const repriced = livePosition(held, {});

    expect(repriced.current_price).toBe(60);
    expect(repriced.market_value).toBe(240);
    expect(repriced.unrealized_pnl).toBe(0);
    expect(repriced.change_percent).toBe(0);
  });

  it("reports a loss when the quote is below cost", () => {
    const repriced = livePosition(position("TSLA", 2, 250, 250), snapshot([["TSLA", 240]]));
    expect(repriced.unrealized_pnl).toBeCloseTo(-20, 6);
    expect(repriced.change_percent).toBeCloseTo(-4, 6);
  });
});

describe("livePortfolio", () => {
  const base = {
    cash_balance: 8450,
    total_value: 0,
    unrealized_pnl: 0,
    positions: [position("AAPL", 10, 188, 188), position("TSLA", 2, 250, 250)],
  };

  it("totals cash plus repriced positions (§8)", () => {
    const live = livePortfolio(base, snapshot([["AAPL", 191.2], ["TSLA", 240]]));

    expect(live.total_value).toBeCloseTo(8450 + 1912 + 480, 6);
    expect(live.unrealized_pnl).toBeCloseTo(32 - 20, 6);
    expect(live.cash_balance).toBe(8450);
  });

  it("ignores stream entries for tickers that aren't held", () => {
    const live = livePortfolio(base, snapshot([["NVDA", 128]]));
    expect(live.positions.map((p) => p.ticker)).toEqual(["AAPL", "TSLA"]);
    expect(live.total_value).toBeCloseTo(8450 + 1880 + 500, 6);
  });

  it("is all cash when nothing is held", () => {
    const live = livePortfolio({ ...base, positions: [] }, {});
    expect(live.total_value).toBe(8450);
    expect(live.unrealized_pnl).toBe(0);
  });
});

describe("weightOf", () => {
  it("measures against total value including cash", () => {
    const held = position("AAPL", 10, 188, 191.2);
    expect(weightOf(held, 10_000)).toBeCloseTo(0.1912, 6);
  });

  it("returns zero instead of dividing by zero on an empty account", () => {
    expect(weightOf(position("AAPL", 10, 188, 191.2), 0)).toBe(0);
  });
});

describe("pnlTone", () => {
  it("uses the §12 thresholds: green above zero, red below, neutral at zero", () => {
    expect(pnlTone(0.01)).toBe("up");
    expect(pnlTone(-0.01)).toBe("down");
    expect(pnlTone(0)).toBe("flat");
  });
});

describe("changeSinceLoad", () => {
  it("measures against the first price seen this session (§10)", () => {
    expect(changeSinceLoad(191.2, 190)).toBeCloseTo(0.6316, 3);
    expect(changeSinceLoad(188, 190)).toBeCloseTo(-1.0526, 3);
    expect(changeSinceLoad(190, 190)).toBe(0);
  });

  it("is null until an anchor exists", () => {
    expect(changeSinceLoad(191.2, undefined)).toBeNull();
    expect(changeSinceLoad(undefined, 190)).toBeNull();
    expect(changeSinceLoad(191.2, 0)).toBeNull();
  });
});

describe("priceOf", () => {
  it("returns null for an untracked ticker", () => {
    const prices = snapshot([["AAPL", 191.2]]);
    expect(priceOf(prices, "AAPL")).toBe(191.2);
    expect(priceOf(prices, "GOOGL")).toBeNull();
  });
});
