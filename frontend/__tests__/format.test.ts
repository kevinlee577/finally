import { describe, expect, it } from "vitest";
import {
  directionOf,
  fmtCompactMoney,
  fmtMoney,
  fmtPct,
  fmtQty,
  fmtSignedMoney,
  isValidTicker,
  normalizeTicker,
} from "@/lib/format";

describe("fmtMoney", () => {
  it("always shows two decimals with grouping", () => {
    expect(fmtMoney(8450)).toBe("8,450.00");
    expect(fmtMoney(0.5)).toBe("0.50");
    expect(fmtMoney(1234567.891)).toBe("1,234,567.89");
  });

  it("renders an em dash for absent or non-finite values", () => {
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
    expect(fmtMoney(Number.NaN)).toBe("—");
    expect(fmtMoney(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("fmtSignedMoney", () => {
  it("signs gains and losses and leaves zero unsigned", () => {
    expect(fmtSignedMoney(120.35)).toBe("+120.35");
    expect(fmtSignedMoney(-120.35)).toBe("−120.35");
    expect(fmtSignedMoney(0)).toBe("0.00");
  });
});

describe("fmtQty", () => {
  it("keeps fractional shares but drops trailing zeros", () => {
    expect(fmtQty(10)).toBe("10");
    expect(fmtQty(3.5)).toBe("3.5");
    expect(fmtQty(0.123456)).toBe("0.123456");
  });

  it("rounds to the 6-decimal precision the backend persists", () => {
    expect(fmtQty(0.1234567)).toBe("0.123457");
  });
});

describe("fmtPct", () => {
  it("signs and fixes to two decimals", () => {
    expect(fmtPct(1.7)).toBe("+1.70%");
    expect(fmtPct(-0.125)).toBe("−0.13%");
    expect(fmtPct(0)).toBe("0.00%");
  });
});

describe("fmtCompactMoney", () => {
  it("abbreviates only above the thousands threshold", () => {
    expect(fmtCompactMoney(950)).toBe("950.00");
    expect(fmtCompactMoney(12_500)).toBe("12.5K");
    expect(fmtCompactMoney(2_400_000)).toBe("2.4M");
  });
});

describe("directionOf", () => {
  it("maps sign to the stream's direction vocabulary", () => {
    expect(directionOf(0.2)).toBe("up");
    expect(directionOf(-0.2)).toBe("down");
    expect(directionOf(0)).toBe("flat");
  });
});

describe("ticker normalization", () => {
  it("upper-cases and trims, matching the backend rule", () => {
    expect(normalizeTicker("  aapl ")).toBe("AAPL");
    expect(normalizeTicker("brk.b")).toBe("BRK.B");
  });

  it("accepts letters, dots, and dashes", () => {
    expect(isValidTicker("AAPL")).toBe(true);
    expect(isValidTicker("BRK.B")).toBe(true);
    expect(isValidTicker("RDS-A")).toBe(true);
  });

  it("rejects empty, numeric, and non-ASCII symbols", () => {
    expect(isValidTicker("")).toBe(false);
    expect(isValidTicker("12X")).toBe(false);
    expect(isValidTicker("AA PL")).toBe(false);
    expect(isValidTicker("🚀")).toBe(false);
  });
});
