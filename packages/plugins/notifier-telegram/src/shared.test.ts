import { describe, it, expect } from "vitest";
import { splitForTelegram } from "./shared.js";

describe("splitForTelegram", () => {
  it("returns a short string as a single chunk", () => {
    expect(splitForTelegram("hello", 100)).toEqual(["hello"]);
  });

  it("returns the whole string when it is exactly at the limit", () => {
    const s = "x".repeat(50);
    expect(splitForTelegram(s, 50)).toEqual([s]);
  });

  it("breaks on a newline boundary in preference to a hard cut", () => {
    // limit 6, "aaaa\nbbbb" (9 chars): newline at index 4 → clean split, \n consumed.
    expect(splitForTelegram("aaaa\nbbbb", 6)).toEqual(["aaaa", "bbbb"]);
  });

  it("falls back to a space boundary when there is no newline", () => {
    expect(splitForTelegram("aaaa bbbb", 6)).toEqual(["aaaa", "bbbb"]);
  });

  it("hard-cuts a single token longer than the limit", () => {
    expect(splitForTelegram("z".repeat(250), 100)).toEqual([
      "z".repeat(100),
      "z".repeat(100),
      "z".repeat(50),
    ]);
  });

  it("keeps every chunk within the limit and loses no non-boundary characters", () => {
    const s = ("a".repeat(40) + "\n").repeat(50); // 2050 chars, newline every 41
    const chunks = splitForTelegram(s, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    // Letters are never dropped — only the boundary newline is consumed at a split.
    expect(chunks.join("").replace(/\n/g, "")).toBe("a".repeat(40 * 50));
  });

  it("treats a non-positive limit as a single chunk (no infinite loop)", () => {
    expect(splitForTelegram("anything", 0)).toEqual(["anything"]);
  });
});
