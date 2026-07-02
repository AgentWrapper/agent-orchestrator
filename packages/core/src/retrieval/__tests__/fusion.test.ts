import { describe, it, expect } from "vitest";
import {
  dedupeGraphItems,
  dedupeVectorItems,
  dedupeCrossModal,
  interleaveWeighted,
  fuseRetrievalItems,
} from "../fusion.js";
import type { RetrievalCitation, RetrievalItem } from "../types.js";

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

function vectorItem(
  rank: number,
  sessionId: string,
  text: string,
  citations: RetrievalCitation[] = [],
): RetrievalItem {
  return {
    provider: "vector",
    kind: "transcript",
    file: null,
    line: null,
    score: 1 / (rank + 1),
    rank,
    text,
    tokens: 5,
    citations,
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

describe("dedupeCrossModal", () => {
  it("drops a vector item whose citations are ≥60% covered by graph items", () => {
    const graphItems = [graphItem(0, "a.ts", 10), graphItem(1, "b.ts", 50)];
    const vectorItems = [
      vectorItem(0, "s", "covered", [
        { file: "a.ts", line: 11 },
        { file: "b.ts", line: 50 },
      ]),
    ];
    const { kept, dropped } = dedupeCrossModal(graphItems, vectorItems);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("keeps a vector item with novel citations not covered by graph items", () => {
    const graphItems = [graphItem(0, "a.ts", 10)];
    const vectorItems = [
      vectorItem(0, "s", "novel", [
        { file: "a.ts", line: 11 },
        { file: "z.ts", line: 999 },
      ]),
    ];
    const { kept, dropped } = dedupeCrossModal(graphItems, vectorItems);
    expect(kept).toHaveLength(1); // only 50% coverage — below the 60% threshold
    expect(dropped).toHaveLength(0);
  });

  it("never drops a graph item in favor of a vector item", () => {
    const graphItems = [graphItem(0, "a.ts", 10)];
    const vectorItems = [vectorItem(0, "s", "covered", [{ file: "a.ts", line: 10 }])];
    const { dropped } = dedupeCrossModal(graphItems, vectorItems);
    expect(dropped).toHaveLength(1);
    // graphItems is never mutated or filtered by this function.
    expect(graphItems).toHaveLength(1);
  });
});

describe("fuseRetrievalItems", () => {
  it("dedups intra-modally then interleaves when there is no cross-modal overlap", () => {
    const graphItems = [graphItem(0, "a.ts", 10), graphItem(1, "a.ts", 11)];
    const vectorItems = [vectorItem(0, "s", "hit")];
    const { items } = fuseRetrievalItems({
      graphItems,
      vectorItems,
      graphWeight: 0.55,
      vectorWeight: 0.45,
    });
    expect(items).toHaveLength(2); // graph deduped 2→1, vector untouched
  });

  it("drops cross-modally covered vector items and reports dedupSavedTokens per provider", () => {
    const graphItems = [graphItem(0, "a.ts", 10)];
    const vectorItems = [vectorItem(0, "s", "covered", [{ file: "a.ts", line: 10 }])];
    const { items, dedupSavedTokens } = fuseRetrievalItems({
      graphItems,
      vectorItems,
      graphWeight: 0.55,
      vectorWeight: 0.45,
    });
    expect(items).toEqual(graphItems);
    expect(dedupSavedTokens).toEqual({ graph: 0, vector: 5 });
  });
});
