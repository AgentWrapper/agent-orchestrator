import { describe, it, expect, vi } from "vitest";
import { assembleContextBundle } from "../index.js";
import type { RetrievalItem, RetrievalProvider, TaskContext } from "../types.js";

const CTX: TaskContext = { projectId: "p_1", projectRoot: "/tmp/p", taskText: "fix the spawn bug" };

function fakeProvider(name: "graph" | "vector", available: boolean, items: RetrievalItem[]): RetrievalProvider {
  return {
    name,
    available: vi.fn(async () => available),
    query: vi.fn(async () => items),
  };
}

function graphItem(text: string): RetrievalItem {
  return {
    provider: "graph",
    kind: "symbol",
    file: "a.ts",
    line: 1,
    score: 1,
    rank: 0,
    text,
    tokens: 10,
    citations: [],
  };
}

function vectorItem(text: string): RetrievalItem {
  return {
    provider: "vector",
    kind: "transcript",
    file: null,
    line: null,
    score: 1,
    rank: 0,
    text,
    tokens: 10,
    citations: [],
  };
}

const noopEnsureGraphBuilt = vi.fn(async () => false);

describe("assembleContextBundle", () => {
  it("returns null when there is no task text", async () => {
    const bundle = await assembleContextBundle(
      { ...CTX, taskText: undefined },
      {
        graphProvider: fakeProvider("graph", true, [graphItem("g")]),
        vectorProvider: fakeProvider("vector", true, [vectorItem("v")]),
        ensureGraphBuiltFn: noopEnsureGraphBuilt,
      },
    );
    expect(bundle).toBeNull();
  });

  it("returns null when neither provider is available", async () => {
    const bundle = await assembleContextBundle(CTX, {
      graphProvider: fakeProvider("graph", false, []),
      vectorProvider: fakeProvider("vector", false, []),
      ensureGraphBuiltFn: noopEnsureGraphBuilt,
    });
    expect(bundle).toBeNull();
  });

  it("degrades to vector-only when graph is unavailable", async () => {
    const graphProvider = fakeProvider("graph", false, [graphItem("should not appear")]);
    const vectorProvider = fakeProvider("vector", true, [vectorItem("vector hit")]);
    const bundle = await assembleContextBundle(CTX, {
      graphProvider,
      vectorProvider,
      ensureGraphBuiltFn: noopEnsureGraphBuilt,
    });
    expect(bundle).not.toBeNull();
    expect(bundle!.markdown).toContain("vector hit");
    expect(bundle!.markdown).not.toContain("### Структура кода (graphify)");
    expect(vectorProvider.query).toHaveBeenCalled();
    // Unavailable provider is never queried — graphWeight is 0.
    expect(graphProvider.query).not.toHaveBeenCalled();
  });

  it("fuses graph + vector results into one bundle when both are available", async () => {
    const bundle = await assembleContextBundle(CTX, {
      graphProvider: fakeProvider("graph", true, [graphItem("graph hit")]),
      vectorProvider: fakeProvider("vector", true, [vectorItem("vector hit")]),
      ensureGraphBuiltFn: noopEnsureGraphBuilt,
    });
    expect(bundle).not.toBeNull();
    expect(bundle!.markdown).toContain("graph hit");
    expect(bundle!.markdown).toContain("vector hit");
    expect(bundle!.json.itemsPacked).toBe(2);
  });

  it("fails open (returns null) when a provider's query rejects", async () => {
    const graphProvider = fakeProvider("graph", true, []);
    graphProvider.query = vi.fn(async () => {
      throw new Error("boom");
    });
    const bundle = await assembleContextBundle(CTX, {
      graphProvider,
      vectorProvider: fakeProvider("vector", false, []),
      ensureGraphBuiltFn: noopEnsureGraphBuilt,
    });
    expect(bundle).toBeNull();
  });
});
