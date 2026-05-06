import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_KEY,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  getStoredFontSize,
} from "../terminal-font";

// jsdom's localStorage proxy in this setup doesn't expose `removeItem`/`clear`
// reliably between suites, so we stub it ourselves with a fresh Map per test.
describe("getStoredFontSize", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the default when nothing is stored", () => {
    expect(getStoredFontSize()).toBe(FONT_SIZE_DEFAULT);
  });

  it("returns the stored value when within bounds", () => {
    localStorage.setItem(FONT_SIZE_KEY, "14");
    expect(getStoredFontSize()).toBe(14);
  });

  it("clamps below the minimum", () => {
    localStorage.setItem(FONT_SIZE_KEY, "2");
    expect(getStoredFontSize()).toBe(FONT_SIZE_MIN);
  });

  it("clamps above the maximum", () => {
    localStorage.setItem(FONT_SIZE_KEY, "99");
    expect(getStoredFontSize()).toBe(FONT_SIZE_MAX);
  });

  it("returns the default when the stored value is not a number", () => {
    localStorage.setItem(FONT_SIZE_KEY, "banana");
    expect(getStoredFontSize()).toBe(FONT_SIZE_DEFAULT);
  });

  it("parses leading-integer strings (parseInt behaviour) and clamps", () => {
    // parseInt("14px", 10) === 14 — documenting current behaviour.
    localStorage.setItem(FONT_SIZE_KEY, "14px");
    expect(getStoredFontSize()).toBe(14);
  });

  it("falls back to the default when localStorage.getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: access denied");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    expect(getStoredFontSize()).toBe(FONT_SIZE_DEFAULT);
  });
});
