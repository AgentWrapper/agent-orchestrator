import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect } from "vitest";

expect.extend(matchers);
afterEach(() => {
  cleanup();
});

// jsdom does not implement window.matchMedia. Provide a minimal stub so
// components that call useMediaQuery (e.g. Dashboard) work in unit tests.
// The stub always returns `false` (non-matching), which keeps tests in the
// desktop/non-mobile rendering path and avoids spurious re-renders.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
