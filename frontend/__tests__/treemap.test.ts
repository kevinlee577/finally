import { describe, expect, it } from "vitest";
import { squarify, type TreemapItem } from "@/lib/treemap";

const WIDTH = 400;
const HEIGHT = 200;

function totalArea(items: TreemapItem[]) {
  return squarify(items, WIDTH, HEIGHT).reduce((sum, r) => sum + r.width * r.height, 0);
}

describe("squarify", () => {
  it("fills the container exactly", () => {
    const items = [
      { key: "AAPL", value: 1912 },
      { key: "NVDA", value: 1024 },
      { key: "TSLA", value: 860 },
      { key: "MSFT", value: 830 },
    ];
    expect(totalArea(items)).toBeCloseTo(WIDTH * HEIGHT, 3);
  });

  it("gives every item a rectangle, once", () => {
    const items = [
      { key: "A", value: 5 },
      { key: "B", value: 3 },
      { key: "C", value: 2 },
      { key: "D", value: 1 },
      { key: "E", value: 1 },
    ];
    const keys = squarify(items, WIDTH, HEIGHT).map((r) => r.key);
    expect(keys.sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("sizes rectangles in proportion to value", () => {
    const rects = squarify(
      [
        { key: "BIG", value: 3 },
        { key: "SMALL", value: 1 },
      ],
      WIDTH,
      HEIGHT,
    );
    const big = rects.find((r) => r.key === "BIG")!;
    const small = rects.find((r) => r.key === "SMALL")!;
    expect((big.width * big.height) / (small.width * small.height)).toBeCloseTo(3, 3);
  });

  it("keeps every rectangle inside the container", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ key: `T${i}`, value: 12 - i }));
    for (const rect of squarify(items, WIDTH, HEIGHT)) {
      expect(rect.x).toBeGreaterThanOrEqual(-0.001);
      expect(rect.y).toBeGreaterThanOrEqual(-0.001);
      expect(rect.x + rect.width).toBeLessThanOrEqual(WIDTH + 0.001);
      expect(rect.y + rect.height).toBeLessThanOrEqual(HEIGHT + 0.001);
    }
  });

  it("produces roughly square tiles for evenly weighted items", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ key: `T${i}`, value: 1 }));
    for (const rect of squarify(items, 300, 300)) {
      const ratio = Math.max(rect.width / rect.height, rect.height / rect.width);
      expect(ratio).toBeLessThan(3);
    }
  });

  it("lays out a single item as the whole container", () => {
    const [only] = squarify([{ key: "AAPL", value: 42 }], WIDTH, HEIGHT);
    expect(only).toMatchObject({ key: "AAPL", x: 0, y: 0, width: WIDTH, height: HEIGHT });
  });

  it("drops non-positive values instead of producing inverted rectangles", () => {
    const rects = squarify(
      [
        { key: "A", value: 10 },
        { key: "ZERO", value: 0 },
        { key: "NEG", value: -5 },
      ],
      WIDTH,
      HEIGHT,
    );
    expect(rects.map((r) => r.key)).toEqual(["A"]);
  });

  it("returns nothing for an empty set or a zero-sized container", () => {
    expect(squarify([], WIDTH, HEIGHT)).toEqual([]);
    expect(squarify([{ key: "A", value: 1 }], 0, HEIGHT)).toEqual([]);
    expect(squarify([{ key: "A", value: 1 }], WIDTH, 0)).toEqual([]);
  });
});
