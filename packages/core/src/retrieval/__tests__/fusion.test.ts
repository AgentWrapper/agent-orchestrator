import { describe, it, expect } from "vitest";
import {
  dedupeGraphItems,
  dedupeVectorItems,
  interleaveWeighted,
  fuseRetrievalItems,
} from "../fusion.js";
import type { RetrievalItem } from "../types.js";

function graphItem(rank: number, file: string, line: number | null): RetrievalItem {
  return {
    provider: "graph",
    kind: "symbol",
    file,
    line,
    score: 1 / (rank + 1),
    rank,
    text: `node ${rank}`,
    tokens: 5,
    citations: [],
  };
}

function vectorItem(rank: number, sessionId: string, text: string): RetrievalItem {
  return {
    provider: "vector",
    kind: "transcript",
    file: null,
    line: null,
    score: 1 / (rank + 1),
    rank,
    text,
    tokens: 5,
    citations: [],
    meta: { sessionId },
  };
}

describe("dedupeGraphItems", () => {
  it("drops items within ±3 lines of an already-seen (file, line), keeping the first", () => {
    const items = [
      graphItem(0, "a.ts", 10),
      graphItem(1, "a.ts", 12), // within ±3 of 10 → dup
      graphItem(2, "a.ts", 20), // outside ±3 → kept
      graphItem(3, "b.ts", 10), // different file → kept
    ];
    const out = dedupeGraphItems(items);
    expect(out.map((i) => `${i.file}:${i.line}`)).toEqual(["a.ts:10", "a.ts:20", "b.ts:10"]);
  });

  it("never dedups fileless items against each other", () => {
    const items = [graphItem(0, "", 0), graphItem(1, "", 0)].map((i) => ({
      ...i,
      file: null,
      line: null,
    }));
    expect(dedupeGraphItems(items)).toHaveLength(2);
  });
});

describe("dedupeVectorItems", () => {
  it("drops exact (session, text) repeats, keeping the first", () => {
    const items = [
      vectorItem(0, "mae-1", "same snippet"),
      vectorItem(1, "mae-1", "same snippet"),
      vectorItem(2, "mae-2", "same snippet"),
    ];
    const out = dedupeVectorItems(items);
    expect(out).toHaveLength(2);
  });
});

describe("interleaveWeighted", () => {
  it("drains both lists fully in their own rank order", () => {
    const graph = [graphItem(0, "a.ts", 1), graphItem(1, "a.ts", 100)];
    const vector = [vectorItem(0, "s", "v0"), vectorItem(1, "s", "v1")];
    const out = interleaveWeighted(graph, 0.55, vector, 0.45);
    expect(out).toHaveLength(4);
    expect(out.filter((i) => i.provider === "graph").map((i) => i.rank)).toEqual([0, 1]);
    expect(out.filter((i) => i.provider === "vector").map((i) => i.rank)).toEqual([0, 1]);
  });

  it("emits only from the non-empty list when the other is empty", () => {
    const vector = [vectorItem(0, "s", "v0"), vectorItem(1, "s", "v1")];
    const out = interleaveWeighted([], 0.55, vector, 0.45);
    expect(out).toEqual(vector);
  });
});

describe("fuseRetrievalItems", () => {
  it("dedups intra-modally then interleaves — no cross-modal dedup", () => {
    const graphItems = [graphItem(0, "a.ts", 10), graphItem(1, "a.ts", 11)];
    const vectorItems = [vectorItem(0, "s", "hit")];
    const out = fuseRetrievalItems({
      graphItems,
      vectorItems,
      graphWeight: 0.55,
      vectorWeight: 0.45,
    });
    expect(out).toHaveLength(2); // graph deduped 2→1, vector untouched
  });
});
