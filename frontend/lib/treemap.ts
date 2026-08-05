/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk).
 *
 * Written by hand rather than pulled from the chart library: the portfolio
 * heatmap is the only treemap in the app, the algorithm is short, and keeping
 * it as a pure function makes the layout unit-testable without a DOM.
 */
export interface TreemapItem {
  key: string;
  /** Must be positive; non-positive items are dropped. */
  value: number;
}

export interface TreemapRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Scaled extends TreemapItem {
  area: number;
}

/** Worst aspect ratio in a row laid along `length`. Lower is squarer. */
function worst(row: Scaled[], length: number): number {
  if (row.length === 0 || length <= 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const item of row) {
    sum += item.area;
    if (item.area > max) max = item.area;
    if (item.area < min) min = item.area;
  }
  if (sum <= 0 || min <= 0) return Number.POSITIVE_INFINITY;
  const s2 = sum * sum;
  const l2 = length * length;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

export function squarify(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  if (width <= 0 || height <= 0) return [];
  const positive = items.filter((item) => item.value > 0);
  if (positive.length === 0) return [];

  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const scale = (width * height) / total;
  const scaled: Scaled[] = sorted.map((item) => ({ ...item, area: item.value * scale }));

  const out: TreemapRect[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  /** Places `row` against the current short side and shrinks the free area. */
  function flush(row: Scaled[], length: number) {
    const sum = row.reduce((acc, item) => acc + item.area, 0);
    if (sum <= 0 || length <= 0) return;
    const thickness = sum / length;

    if (w >= h) {
      let offset = y;
      for (const item of row) {
        const itemHeight = item.area / thickness;
        out.push({ key: item.key, x, y: offset, width: thickness, height: itemHeight });
        offset += itemHeight;
      }
      x += thickness;
      w -= thickness;
    } else {
      let offset = x;
      for (const item of row) {
        const itemWidth = item.area / thickness;
        out.push({ key: item.key, x: offset, y, width: itemWidth, height: thickness });
        offset += itemWidth;
      }
      y += thickness;
      h -= thickness;
    }
  }

  let row: Scaled[] = [];
  let index = 0;
  while (index < scaled.length) {
    const length = Math.min(w, h);
    if (length <= 0) break;
    const candidate = scaled[index];
    if (row.length === 0 || worst([...row, candidate], length) <= worst(row, length)) {
      row.push(candidate);
      index += 1;
    } else {
      flush(row, length);
      row = [];
    }
  }
  if (row.length > 0) flush(row, Math.min(w, h));

  // Anything left unplaced (degenerate free area) still gets a slot so the
  // heatmap never silently omits a position the user holds.
  for (; index < scaled.length; index += 1) {
    out.push({ key: scaled[index].key, x, y, width: Math.max(w, 0), height: Math.max(h, 0) });
  }

  return out;
}
