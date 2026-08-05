/** Number and ticker formatting. Precision rules come from PLAN §7/§8. */

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Money and prices: always 2 decimals, grouped. */
export function fmtMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return money.format(value);
}

/** Signed money, for P&L columns. */
export function fmtSignedMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${money.format(Math.abs(value))}`;
}

/** Quantities carry up to 6 decimals (§7) but shouldn't show `10.000000`. */
export function fmtQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(6)));
}

/** Signed percentage, 2 decimals. */
export function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}%`;
}

/** Compact money for tight cells (heatmap tiles, tape). */
export function fmtCompactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return money.format(value);
}

/** "up" / "down" / "flat" from any signed number. */
export function directionOf(delta: number): "up" | "down" | "flat" {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

/**
 * Client-side ticker normalization mirroring §8 so the UI can reject obvious
 * garbage before a round trip. The backend still re-validates — this only
 * saves a request and gives an instant message.
 */
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidTicker(normalized: string): boolean {
  return /^[A-Z.-]+$/.test(normalized);
}

/** RFC 3339 → clock time for chart axes. */
export function fmtClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
