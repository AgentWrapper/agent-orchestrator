import { describe, it, expect, vi } from "vitest";
import { createVectorProvider, type MaestroSearchRunner } from "../vector-provider.js";
import type { TaskContext } from "../types.js";

const PROJECT = "demo_abc123";
const CTX: TaskContext = { projectId: PROJECT, projectRoot: "/tmp/demo", taskText: "fix the bug" };

function runnerReturning(json: unknown): MaestroSearchRunner {
  return vi.fn(async () => JSON.stringify(json));
}

describe("vector provider", () => {
  it("fails open (returns []) when the runner throws (missing binary)", async () => {
    const provider = createVectorProvider({
      runner: vi.fn(async () => {
        throw Object.assign(new Error("spawn maestro-search ENOENT"), { code: "ENOENT" });
      }),
    });
    const items = await provider.query(CTX, { maxTokens: 500 });
    expect(items).toEqual([]);
  });

  it("filters hits to the current project and maps them to RetrievalItems", async () => {
    const provider = createVectorProvider({
      runner: runnerReturning({
        results: [
          { project_id: PROJECT, session_id: "mae-12", snippet: "Spawn site in session-manager.ts:1841" },
          { project_id: "other_deadbeef", session_id: "x-1", snippet: "unrelated" },
        ],
      }),
    });
    const items = await provider.query(CTX, { maxTokens: 500 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ provider: "vector", kind: "transcript" });
    expect(items[0]!.meta).toMatchObject({ sessionId: "mae-12" });
    expect(items[0]!.citations).toEqual([{ file: "session-manager.ts", line: 1841 }]);
  });

  it("returns [] on unparseable output (fail-open)", async () => {
    const provider = createVectorProvider({ runner: vi.fn(async () => "not json") });
    const items = await provider.query(CTX, { maxTokens: 500 });
    expect(items).toEqual([]);
  });

  it("skips the query entirely when there is no task text", async () => {
    const runner = vi.fn();
    const provider = createVectorProvider({ runner });
    const items = await provider.query({ ...CTX, taskText: "  " }, { maxTokens: 500 });
    expect(items).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
});
