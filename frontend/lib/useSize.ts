"use client";

import { useEffect, useRef, useState } from "react";

export interface Size {
  width: number;
  height: number;
}

/**
 * Measures an element so layout maths (the treemap) can work in real pixels.
 * Starts from a plausible size rather than 0×0 so the first paint is not empty.
 */
export function useSize<T extends HTMLElement>(fallback: Size = { width: 480, height: 220 }) {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const width = element.clientWidth || element.offsetWidth;
      const height = element.clientHeight || element.offsetHeight;
      if (width > 0 && height > 0) setSize({ width, height });
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}
