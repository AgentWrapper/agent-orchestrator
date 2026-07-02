import { describe, it, expect } from "vitest";
import { packBundle } from "../bundle.js";
import type { RetrievalItem } from "../types.js";

function item(provider: "graph" | "vector", tokens: number, text: string): RetrievalItem {
  return {
    provider,
    kind: provider === "graph" ? "symbol" : "transcript",
    file: null,
    line: null,
    score: 1,
    rank: 0,
    text,
    tokens,
    citations: [],
  };
}

describe("packBundle", () => {
  it("packs items in order up to the cap, skipping ones that don't fit (not truncating)", () => {
    const items = [item("graph", 40, "a"), item("graph", 40, "b"), item("vector", 40, "c")];
    const bundle = packBundle(items, { maxTokens: 90 });
    expect(bundle).not.toBeNull();
    expect(bundle!.json.itemsPacked).toBe(2); // a + b = 80 <= 90; c would push to 120 > 90
    expect(bundle!.json.itemsSkipped).toBe(1);
    expect(bundle!.json.tokensPacked).toBe(80);
    expect(bundle!.markdown).toContain("a");
    expect(bundle!.markdown).toContain("b");
    expect(bundle!.markdown).not.toContain("- c");
  });

  it("keeps checking later (smaller) items after skipping one that doesn't fit", () => {
    const items = [item("graph", 60, "big"), item("graph", 20, "small")];
    const bundle = packBundle(items, { maxTokens: 50 });
    expect(bundle!.json.itemsPacked).toBe(1);
    expect(bundle!.markdown).toContain("small");
    expect(bundle!.markdown).not.toContain("big");
  });

  it("emits distinct headings for graph vs vector sections", () => {
    const items = [item("graph", 10, "node text"), item("vector", 10, "snippet text")];
    const bundle = packBundle(items, { maxTokens: 100 });
    expect(bundle!.markdown).toContain("## Контекст задачи (maestro-retrieval)");
    expect(bundle!.markdown).toContain("### Структура кода (graphify)");
    expect(bundle!.markdown).toContain("### Память проекта (rlm)");
  });

  it("returns null when nothing fits", () => {
    const items = [item("graph", 1000, "too big")];
    expect(packBundle(items, { maxTokens: 10 })).toBeNull();
  });

  it("returns null for an empty item list", () => {
    expect(packBundle([], { maxTokens: 1000 })).toBeNull();
  });
});
