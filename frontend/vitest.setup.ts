import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

// Recharts' ResponsiveContainer measures its parent with ResizeObserver, which
// jsdom does not implement. Stub it so chart components render in tests.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no layout engine, so every measured box is 0x0 and Recharts renders
// nothing. Report a fixed size for chart containers.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  value: 640,
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 320,
});

globalThis.scrollTo ??= vi.fn() as unknown as typeof globalThis.scrollTo;
Element.prototype.scrollTo ??= vi.fn();
