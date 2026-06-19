import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect } from "vitest";

// Node.js 25 exposes a native localStorage stub via --localstorage-file that
// lacks .clear()/.key()/.length. Replace it with a complete in-memory mock so
// tests that call window.localStorage.clear() work on any Node version.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      Reflect.deleteProperty(store, k);
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

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
