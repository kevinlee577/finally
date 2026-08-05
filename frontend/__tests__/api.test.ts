import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";

function respond(status: number, body: unknown, { empty = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (empty ? "" : JSON.stringify(body)),
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("error envelope handling (§8)", () => {
  it("surfaces the machine-readable code and message from the envelope", async () => {
    fetchMock.mockResolvedValue(
      respond(400, { error: { code: "insufficient_cash", message: "Buy exceeds cash balance." } }),
    );

    await expect(api.trade({ ticker: "AAPL", quantity: 1000, side: "buy" })).rejects.toMatchObject({
      code: "insufficient_cash",
      message: "Buy exceeds cash balance.",
      status: 400,
    });
  });

  it("maps each documented failure code through unchanged", async () => {
    for (const code of [
      "validation_error",
      "invalid_ticker",
      "invalid_side",
      "not_watchlisted",
      "no_position",
      "duplicate_ticker",
      "insufficient_shares",
      "quote_unavailable",
      "chat_unavailable",
      "internal_error",
    ]) {
      fetchMock.mockResolvedValue(respond(400, { error: { code, message: code } }));
      await expect(api.portfolio()).rejects.toMatchObject({ code });
    }
  });

  it("falls back to internal_error when the body isn't a valid envelope", async () => {
    fetchMock.mockResolvedValue(respond(500, null, { empty: true }));
    const error = await api.portfolio().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("internal_error");
  });

  it("reports an unreachable server as network_error rather than throwing raw", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.health()).rejects.toMatchObject({ code: "network_error", status: 0 });
  });
});

describe("request shapes", () => {
  it("unwraps the watchlist envelope", async () => {
    fetchMock.mockResolvedValue(
      respond(200, { watchlist: [{ ticker: "AAPL", added_at: "x", price: 191.2 }] }),
    );
    await expect(api.watchlist()).resolves.toEqual([
      { ticker: "AAPL", added_at: "x", price: 191.2 },
    ]);
  });

  it("unwraps the history envelope", async () => {
    fetchMock.mockResolvedValue(respond(200, { snapshots: [{ total_value: 10000, recorded_at: "x" }] }));
    await expect(api.history()).resolves.toEqual([{ total_value: 10000, recorded_at: "x" }]);
  });

  it("posts the trade body as JSON", async () => {
    fetchMock.mockResolvedValue(respond(200, { cash_balance: 8450, position: null }));
    await api.trade({ ticker: "AAPL", quantity: 2.5, side: "buy" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/portfolio/trade");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ ticker: "AAPL", quantity: 2.5, side: "buy" });
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("treats DELETE's 204 as success with no body to parse", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => "" } as Response);
    await expect(api.removeTicker("AAPL")).resolves.toBeUndefined();
  });

  it("percent-encodes the ticker in the delete path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => "" } as Response);
    await api.removeTicker("BRK.B");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/watchlist/BRK.B");
  });
});
