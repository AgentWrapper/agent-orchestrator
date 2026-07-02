import { describe, it, expect, vi } from "vitest";
import { applyRelevanceFloor, createGraphProvider } from "../graph-provider.js";
import type { RetrievalItem, TaskContext } from "../types.js";

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
    const items = await provider.query(
      { ...CTX, taskText: "rebuild graph-store ensureGraphBuilt flow" },
      { maxTokens: 500 },
    );
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

  it("degrades to [] when a code-shaped query hits an unrelated (ops) graph", async () => {
    const stdout = [
      "NODE ChatBubble.swift [src=Sources/ChatBubble.swift loc=L1 community=1]",
      "NODE renderMarkdown() [src=Sources/ChatBubble.swift loc=L40 community=1]",
      "EDGE ChatBubble.swift --contains [EXTRACTED]--> renderMarkdown()",
      "",
    ].join("\n");
    const provider = createGraphProvider({ queryRunner: vi.fn(async () => stdout) });
    const items = await provider.query(
      { ...CTX, taskText: "build and notarize the release DMG and publish the appcast" },
      { maxTokens: 500 },
    );
    expect(items).toEqual([]);
  });
});

describe("applyRelevanceFloor", () => {
  const node = (label: string, src: string, loc: number): RetrievalItem => ({
    provider: "graph",
    kind: "symbol",
    file: src,
    line: loc,
    score: 1,
    rank: 0,
    text: `NODE ${label} [src=${src} loc=L${loc} community=0]`,
    tokens: 10,
    citations: [],
    meta: { label },
  });

  const edge = (from: string, to: string): RetrievalItem => ({
    provider: "graph",
    kind: "subgraph",
    file: null,
    line: null,
    score: 1,
    rank: 0,
    text: `EDGE ${from} --contains [EXTRACTED]--> ${to}`,
    tokens: 10,
    citations: [],
    meta: { from, rel: "contains", to, confidence: "EXTRACTED" },
  });

  it("drops all items when none share a term with the query", () => {
    const items = [node("WebChatBridge.swift", "WebChatBridge.swift", 1)];
    expect(applyRelevanceFloor(items, "notarize the release DMG")).toEqual([]);
  });

  it("keeps a direct hit plus its 1-hop neighborhood, drops unrelated nodes", () => {
    const hit = node("WebChatBridge.swift", "WebChatBridge.swift", 1);
    const neighbor = node("applyFull()", "WebChatBridge.swift", 726);
    const unrelated = node("dist.sh", "scripts/dist.sh", 1);
    const linkingEdge = edge("WebChatBridge.swift", "applyFull()");
    const items = [hit, neighbor, unrelated, linkingEdge];

    const kept = applyRelevanceFloor(items, "fix WebChatBridge renamespace reconnect");

    expect(kept).toContain(hit);
    expect(kept).toContain(neighbor);
    expect(kept).toContain(linkingEdge);
    expect(kept).not.toContain(unrelated);
  });

  it("passes items through unchanged when the query has no meaningful terms", () => {
    const items = [node("dist.sh", "scripts/dist.sh", 1)];
    expect(applyRelevanceFloor(items, "ok")).toEqual(items);
  });
});
