"use client";

/**
 * Price flash (PLAN §10): on a price change, paint a brief directional wipe
 * over the row, then let it fade.
 *
 * The class is applied imperatively rather than through React state because
 * ticks can arrive faster than the 520ms animation. Re-adding the same class
 * name would not restart a running animation, so the class is removed, layout
 * is forced, and it is added again — the standard restart.
 */
import { useEffect, useRef } from "react";

const CLASSES = ["flash-up", "flash-down"];

export function useFlash<T extends HTMLElement>(price: number | null | undefined) {
  const ref = useRef<T | null>(null);
  const previous = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    const before = previous.current;
    previous.current = price;

    // Nothing to compare against on the first price we ever see.
    if (!element || price == null || before == null || price === before) return;

    element.classList.remove(...CLASSES);
    void element.offsetWidth; // Force reflow so the animation restarts.
    element.classList.add(price > before ? "flash-up" : "flash-down");
  }, [price]);

  return ref;
}
