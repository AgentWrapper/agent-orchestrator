import { describe, it, expect, vi } from "vitest";
import { createGraphProvider } from "../graph-provider.js";
import type { TaskContext } from "../types.js";

const CTX: TaskContext = {
  projectId: "demo_abc123",
  projectRoot: "/tmp/demo",
  taskText: "wire up spawn flow",
};

describe("graph provider", () => {
  it("fails open (returns []) when the runner throws (missing binary)", async () => {
    const provider = createGraphProvider({
      queryRunner: vi.fn(async () => {
        throw Object.assign(new Error("spawn graphify ENOENT"), { code: "ENOENT" });
      }),
    });
    const items = await provider.query(CTX, { maxTokens: 500 });
    expect(items).toEqual([]);
  });

  it("is unavailable when graph.json hasn't been built yet, even if the binary resolves", async () => {
    const provider = createGraphProvider({
      binResolver: vi.fn(async () => true),
    });
    expect(await provider.available({ ...CTX, projectId: "never-built_zzz999" })).toBe(false);
  });

  it("parses NODE and EDGE lines from graphify query output", async () => {
    const stdout = [
      "NODE graph-store.ts [src=graph-store.ts loc=L1 community=1]",
      "NODE ensureGraphBuilt() [src=graph-store.ts loc=L103 community=0]",
      "EDGE graph-store.ts --contains [EXTRACTED]--> ensureGraphBuilt()",
      "",
    ].join("\n");
    const provider = createGraphProvider({
      queryRunner: vi.fn(async () => stdout),
    });
    const items = await provider.query(CTX, { maxTokens: 500 });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      provider: "graph",
      kind: "symbol",
      file: "graph-store.ts",
      line: 1,
    });
    expect(items[2]).toMatchObject({ provider: "graph", kind: "subgraph", file: null });
  });

  it("returns [] on 'No matching nodes found.'", async () => {
    const provider = createGraphProvider({
      queryRunner: vi.fn(async () => "No matching nodes found.\n"),
    });
    const items = await provider.query(CTX, { maxTokens: 500 });
    expect(items).toEqual([]);
  });

  it("skips the query entirely when there is no task text", async () => {
    const queryRunner = vi.fn();
    const provider = createGraphProvider({ queryRunner });
    const items = await provider.query({ ...CTX, taskText: undefined }, { maxTokens: 500 });
    expect(items).toEqual([]);
    expect(queryRunner).not.toHaveBeenCalled();
  });
});
