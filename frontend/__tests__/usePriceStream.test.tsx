import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePriceStream } from "@/lib/usePriceStream";
import { snapshot } from "./fixtures";

/** Minimal stand-in for the browser EventSource, driven manually by tests. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  /** Emits a default `message` event, matching the server's nameless frames. */
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  emitRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>);
  }

  /** readyState 0 = reconnecting, 2 = given up. */
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

describe("connection lifecycle", () => {
  it("connects to the documented endpoint", () => {
    renderHook(() => usePriceStream());
    expect(FakeEventSource.last().url).toBe("/api/stream/prices");
  });

  it("starts as reconnecting, since the feed isn't live until it opens", () => {
    const { result } = renderHook(() => usePriceStream());
    expect(result.current.status).toBe("reconnecting");
  });

  it("reports connected once the stream opens", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().open());
    expect(result.current.status).toBe("connected");
  });

  it("reports reconnecting while EventSource retries on its own", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().open());
    act(() => FakeEventSource.last().fail(0));
    expect(result.current.status).toBe("reconnecting");
  });

  it("reports disconnected once EventSource gives up", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().fail(2));
    expect(result.current.status).toBe("disconnected");
  });

  it("recovers to connected when frames resume after an error", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().fail(0));
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190]])));
    expect(result.current.status).toBe("connected");
  });

  it("closes the stream on unmount", () => {
    const { unmount } = renderHook(() => usePriceStream());
    const source = FakeEventSource.last();
    unmount();
    expect(source.closed).toBe(true);
  });
});

describe("price frames", () => {
  it("replaces the price map wholesale rather than merging (§6)", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190], ["GOOGL", 175]])));
    expect(Object.keys(result.current.prices).sort()).toEqual(["AAPL", "GOOGL"]);

    // A ticker that stops being tracked simply stops appearing in frames.
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 191]])));
    expect(Object.keys(result.current.prices)).toEqual(["AAPL"]);
    expect(result.current.prices.AAPL.price).toBe(191);
  });

  it("ignores a malformed frame and keeps the last good prices", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190]])));
    act(() => FakeEventSource.last().emitRaw("{not json"));
    expect(result.current.prices.AAPL.price).toBe(190);
  });
});

describe("session anchors (§10)", () => {
  it("anchors change-since-load on the first price seen for a ticker", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190]])));
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 195]])));
    expect(result.current.firstSeen.AAPL).toBe(190);
  });

  it("anchors a ticker added mid-session at its own first frame", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190]])));
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 195], ["PYPL", 60]])));
    expect(result.current.firstSeen).toEqual({ AAPL: 190, PYPL: 60 });
  });
});

describe("history accumulation", () => {
  it("appends a point per ticker per frame", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit({ AAPL: point("AAPL", 190, 1) }));
    act(() => FakeEventSource.last().emit({ AAPL: point("AAPL", 191, 2) }));
    act(() => FakeEventSource.last().emit({ AAPL: point("AAPL", 192, 3) }));

    expect(result.current.history.AAPL.map((p) => p.price)).toEqual([190, 191, 192]);
  });

  it("does not re-append a ticker that didn't move", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit({ AAPL: point("AAPL", 190, 1) }));
    // The stream re-sends every tracked ticker each frame; a repeat of the same
    // timestamp means this ticker didn't tick.
    act(() => FakeEventSource.last().emit({ AAPL: point("AAPL", 190, 1) }));
    expect(result.current.history.AAPL).toHaveLength(1);
  });
});

describe("reconnect", () => {
  it("is not called on its own — a fatal error stays disconnected until asked", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().fail(2));

    expect(result.current.status).toBe("disconnected");
    // Native EventSource does not retry after giving up, and neither do we.
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("opens a fresh stream and closes the dead one", () => {
    const { result } = renderHook(() => usePriceStream());
    const dead = FakeEventSource.last();
    act(() => dead.fail(2));

    act(() => result.current.reconnect());

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(dead.closed).toBe(true);
    expect(FakeEventSource.last()).not.toBe(dead);
  });

  it("reports the attempt immediately rather than staying red", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().fail(2));
    act(() => result.current.reconnect());

    expect(result.current.status).toBe("reconnecting");
  });

  it("returns to connected once the new stream delivers", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().fail(2));
    act(() => result.current.reconnect());
    act(() => FakeEventSource.last().open());

    expect(result.current.status).toBe("connected");

    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190]])));
    expect(result.current.prices.AAPL.price).toBe(190);
  });

  it("keeps the last known prices, which are stale but labelled as such", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190]])));
    act(() => FakeEventSource.last().fail(2));
    act(() => result.current.reconnect());

    expect(result.current.prices.AAPL.price).toBe(190);
    expect(result.current.firstSeen.AAPL).toBe(190);
  });

  it("can be retried when the reconnect attempt also fails", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().fail(2));
    act(() => result.current.reconnect());
    act(() => FakeEventSource.last().fail(2));
    expect(result.current.status).toBe("disconnected");

    act(() => result.current.reconnect());
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});

describe("forget", () => {
  it("drops all locally accumulated state for a removed ticker", () => {
    const { result } = renderHook(() => usePriceStream());
    act(() => FakeEventSource.last().emit(snapshot([["AAPL", 190], ["PYPL", 60]])));
    act(() => result.current.forget("PYPL"));

    expect(result.current.prices.PYPL).toBeUndefined();
    expect(result.current.firstSeen.PYPL).toBeUndefined();
    expect(result.current.history.PYPL).toBeUndefined();
    expect(result.current.prices.AAPL).toBeDefined();
  });
});

function point(ticker: string, price: number, timestamp: number) {
  return {
    ticker,
    price,
    previous_price: price,
    timestamp,
    change: 0,
    change_percent: 0,
    direction: "flat" as const,
  };
}
