import { describe, it, expect, vi } from "vitest";
import { seedRlmContext, type MaestroSearchRunner } from "../rlm-seed.js";

const PROJECT = "agent-orchestrator-fork_b65b6af9d4";

function runnerReturning(json: unknown): MaestroSearchRunner {
  return vi.fn(async () => JSON.stringify(json));
}

describe("seedRlmContext", () => {
  it("enriches the prompt with snippets + session_id for hits in this project", async () => {
    const runner = runnerReturning({
      query: "spawn flow",
      mode: "bm25",
      results: [
        { project_id: PROJECT, session_id: "mae-12", snippet: "Spawn write site in session-manager.ts" },
        { project_id: PROJECT, session_id: "mae-31", snippet: "rlm-seeding toast block" },
      ],
    });

    const block = await seedRlmContext({
      projectId: PROJECT,
      taskText: "wire up spawn flow",
      runner,
    });

    expect(block).not.toBeNull();
    expect(block).toContain("## Контекст из прошлых/удалённых агентов (rlm)");
    expect(block).toContain("[mae-12] Spawn write site in session-manager.ts");
    expect(block).toContain("[mae-31] rlm-seeding toast block");
  });

  it("filters out hits from other projects (no --project flag on the query)", async () => {
    const runner = runnerReturning({
      results: [
        { project_id: "some-other-project_deadbeef00", session_id: "x-1", snippet: "unrelated" },
        { project_id: null, session_id: null, snippet: "global noise" },
      ],
    });

    const block = await seedRlmContext({ projectId: PROJECT, taskText: "task", runner });
    expect(block).toBeNull();
  });

  it("keeps only this-project hits when results are mixed", async () => {
    const runner = runnerReturning({
      results: [
        { project_id: "other_aaaa", session_id: "y-1", snippet: "ignore me" },
        { project_id: PROJECT, session_id: "mae-9", snippet: "keep me" },
      ],
    });

    const block = await seedRlmContext({ projectId: PROJECT, taskText: "task", runner });
    expect(block).not.toBeNull();
    expect(block).toContain("[mae-9] keep me");
    expect(block).not.toContain("ignore me");
  });

  it("returns null (spawn unaffected) when results are empty", async () => {
    const runner = runnerReturning({ results: [] });
    const block = await seedRlmContext({ projectId: PROJECT, taskText: "task", runner });
    expect(block).toBeNull();
  });

  it("returns null (fail-open) when the runner throws (missing binary / non-zero exit)", async () => {
    const runner: MaestroSearchRunner = vi.fn(async () => {
      throw Object.assign(new Error("spawn maestro-search ENOENT"), { code: "ENOENT" });
    });
    const block = await seedRlmContext({ projectId: PROJECT, taskText: "task", runner });
    expect(block).toBeNull();
  });

  it("returns null (fail-open) when the runner times out", async () => {
    const runner: MaestroSearchRunner = vi.fn(async () => {
      throw Object.assign(new Error("Command failed: timeout"), { killed: true, signal: "SIGTERM" });
    });
    const block = await seedRlmContext({ projectId: PROJECT, taskText: "task", runner });
    expect(block).toBeNull();
  });

  it("returns null (fail-open) on unparseable output", async () => {
    const runner: MaestroSearchRunner = vi.fn(async () => "not json at all");
    const block = await seedRlmContext({ projectId: PROJECT, taskText: "task", runner });
    expect(block).toBeNull();
  });

  it("skips the query entirely when there is no task text", async () => {
    const runner = vi.fn<MaestroSearchRunner>();
    expect(await seedRlmContext({ projectId: PROJECT, taskText: undefined, runner })).toBeNull();
    expect(await seedRlmContext({ projectId: PROJECT, taskText: "   ", runner })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("passes a whitespace-collapsed, truncated query and the requested limit", async () => {
    const runner = vi.fn<MaestroSearchRunner>(async () =>
      JSON.stringify({ results: [{ project_id: PROJECT, session_id: "s", snippet: "hit" }] }),
    );
    await seedRlmContext({
      projectId: PROJECT,
      taskText: "  fix   the\n\nbug  ",
      limit: 8,
      runner,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    const [, query, limit] = runner.mock.calls[0]!;
    expect(query).toBe("fix the bug");
    expect(limit).toBe(8);
  });
});
