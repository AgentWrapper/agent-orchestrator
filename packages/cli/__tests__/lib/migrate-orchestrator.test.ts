import { describe, it, expect } from "vitest";
import type { ProjectConfig } from "@aoagents/ao-core";
import {
  mapOrchestratorRow,
  resolveOrchestratorPrefix,
} from "../../src/lib/migrate-orchestrator.js";

const MTIME = "2026-01-01T00:00:00.000Z";

/** A real-shaped V2 orchestrator metadata record. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "orchestrator",
    agent: "claude-code",
    branch: "orchestrator/app-orchestrator",
    worktree: "/data/worktrees/app/orchestrator/app-orchestrator",
    userPrompt: "drive the project",
    displayName: "App Orchestrator",
    claudeSessionUuid: "11111111-2222-3333-4444-555555555555",
    createdAt: "2026-06-01T10:00:00.000Z",
    lifecycle: {
      version: 2,
      session: {
        kind: "orchestrator",
        state: "working",
        reason: "task_in_progress",
        startedAt: "2026-06-01T10:00:00.000Z",
        completedAt: null,
        terminatedAt: null,
        lastTransitionAt: "2026-06-02T12:00:00.000Z",
      },
      runtime: { state: "alive", lastObservedAt: "2026-06-02T12:30:00.000Z" },
    },
    ...overrides,
  };
}

describe("mapOrchestratorRow", () => {
  it("maps a working claude-code orchestrator with verbatim id and num=0", () => {
    const result = mapOrchestratorRow(record(), "app-project", "app", MTIME);
    expect(result.status).toBe("mapped");
    expect(result.row).toMatchObject({
      id: "app-orchestrator",
      num: 0,
      project_id: "app-project",
      kind: "orchestrator",
      harness: "claude-code",
      activity_state: "active",
      is_terminated: 0,
      runtime_handle_id: "",
      branch: "orchestrator/app-orchestrator",
      workspace_path: "/data/worktrees/app/orchestrator/app-orchestrator",
      prompt: "drive the project",
      display_name: "App Orchestrator",
      agent_session_id: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("derives timestamps: activity/first_signal from lastTransitionAt, created from createdAt", () => {
    const { row } = mapOrchestratorRow(record(), "app", "app", MTIME);
    expect(row?.activity_last_at).toBe("2026-06-02T12:00:00.000Z");
    expect(row?.first_signal_at).toBe("2026-06-02T12:00:00.000Z");
    expect(row?.updated_at).toBe("2026-06-02T12:00:00.000Z");
    expect(row?.created_at).toBe("2026-06-01T10:00:00.000Z");
  });

  it("falls back created_at -> startedAt -> file mtime", () => {
    const noCreated = record({ createdAt: undefined });
    expect(mapOrchestratorRow(noCreated, "app", "app", MTIME).row?.created_at).toBe(
      "2026-06-01T10:00:00.000Z", // startedAt
    );
    const noTimes = record({
      createdAt: undefined,
      lifecycle: { version: 2, session: { state: "idle", terminatedAt: null }, runtime: {} },
    });
    const row = mapOrchestratorRow(noTimes, "app", "app", MTIME).row;
    expect(row?.created_at).toBe(MTIME);
    expect(row?.activity_last_at).toBe(MTIME); // falls through to created_at
  });

  it("maps the 8-state enum onto 5 activity states", () => {
    const states: Array<[string, string]> = [
      ["working", "active"],
      ["not_started", "idle"],
      ["idle", "idle"],
      ["detecting", "idle"],
      ["stuck", "idle"],
      ["needs_input", "waiting_input"],
    ];
    for (const [legacy, expected] of states) {
      const rec = record({ lifecycle: { session: { state: legacy, terminatedAt: null } } });
      expect(mapOrchestratorRow(rec, "p", "p", MTIME).row?.activity_state).toBe(expected);
    }
  });

  it("selects agent_session_id by harness", () => {
    const codex = record({ agent: "codex", codexThreadId: "thread-abc", claudeSessionUuid: undefined });
    expect(mapOrchestratorRow(codex, "p", "p", MTIME).row?.agent_session_id).toBe("thread-abc");

    const opencode = record({ agent: "opencode", opencodeSessionId: "oc-1", claudeSessionUuid: undefined });
    expect(mapOrchestratorRow(opencode, "p", "p", MTIME).row?.agent_session_id).toBe("oc-1");

    const claudeNoUuid = record({ claudeSessionUuid: undefined });
    expect(mapOrchestratorRow(claudeNoUuid, "p", "p", MTIME).row?.agent_session_id).toBe("");
  });

  it("plans a transcript relocation only for claude-code with a uuid + worktree", () => {
    expect(mapOrchestratorRow(record(), "p", "p", MTIME).transcript).toEqual({
      worktree: "/data/worktrees/app/orchestrator/app-orchestrator",
      uuid: "11111111-2222-3333-4444-555555555555",
    });
    // codex carries its resume id in agent_session_id, no file move.
    const codex = record({ agent: "codex", codexThreadId: "t", claudeSessionUuid: undefined });
    expect(mapOrchestratorRow(codex, "p", "p", MTIME).transcript).toBeUndefined();
    // claude-code without a worktree cannot compute a destination slug.
    const noWorktree = record({ worktree: undefined });
    expect(mapOrchestratorRow(noWorktree, "p", "p", MTIME).transcript).toBeUndefined();
  });

  it("skips a terminal orchestrator (state done/terminated or terminatedAt set)", () => {
    const done = record({ lifecycle: { session: { state: "done", terminatedAt: null } } });
    expect(mapOrchestratorRow(done, "p", "p", MTIME)).toMatchObject({ status: "skipped" });

    const terminated = record({
      lifecycle: { session: { state: "working", terminatedAt: "2026-06-03T00:00:00.000Z" } },
    });
    expect(mapOrchestratorRow(terminated, "p", "p", MTIME)).toMatchObject({ status: "skipped" });
  });

  it("skips a non-migratable harness (aider) with a note", () => {
    const aider = record({ agent: "aider" });
    const result = mapOrchestratorRow(aider, "p", "p", MTIME);
    expect(result.status).toBe("skipped");
    expect(result.note).toMatch(/aider.*not migratable/);
  });

  it("double-decodes a stringified lifecycle and a stringified nested session", () => {
    const stringifiedSession = record({
      lifecycle: JSON.stringify({
        version: 2,
        session: JSON.stringify({ state: "needs_input", terminatedAt: null }),
        runtime: {},
      }),
    });
    const result = mapOrchestratorRow(stringifiedSession, "p", "p", MTIME);
    expect(result.status).toBe("mapped");
    expect(result.row?.activity_state).toBe("waiting_input");
  });

  it("reads lifecycle from statePayload when stateVersion === '2'", () => {
    const legacyShape = record({
      lifecycle: undefined,
      stateVersion: "2",
      statePayload: JSON.stringify({ session: { state: "working", terminatedAt: null } }),
    });
    expect(mapOrchestratorRow(legacyShape, "p", "p", MTIME).row?.activity_state).toBe("active");
  });
});

describe("resolveOrchestratorPrefix", () => {
  it("uses the configured sessionPrefix", () => {
    expect(resolveOrchestratorPrefix("some-long-project-id", { sessionPrefix: "app" } as ProjectConfig)).toBe(
      "app",
    );
  });
  it("falls back to the first 12 chars of the project id", () => {
    expect(resolveOrchestratorPrefix("some-long-project-id", {} as ProjectConfig)).toBe(
      "some-long-pr",
    );
    expect(resolveOrchestratorPrefix("short", { sessionPrefix: "  " } as ProjectConfig)).toBe(
      "short",
    );
  });
});
