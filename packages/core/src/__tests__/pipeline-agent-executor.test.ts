/**
 * Tests for the agent executor — the bridge between the pipeline engine and
 * a real AO session. The session manager is mocked; everything else (file I/O
 * for findings, prompt assembly) runs for real against tmpdir.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import {
  AgentExecutorSpawnError,
  asRunId,
  asStageRunId,
  createAgentExecutor,
  STAGE_FINDINGS_RELATIVE_PATH,
  type Stage,
  type StartStageInput,
} from "../pipeline/index.js";
import type {
  Session,
  SessionId,
  SessionManager,
  SessionSpawnConfig,
  KillResult,
} from "../types.js";

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "agent-executor-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function makeStage(overrides: Partial<Stage> = {}): Stage {
  return {
    name: "review",
    trigger: { on: ["pr.opened"] },
    executor: { kind: "agent", plugin: "codex", mode: "review" },
    task: { prompt: "review the diff" },
    ...overrides,
  };
}

function makeStartInput(overrides: Partial<StartStageInput> = {}): StartStageInput {
  return {
    pipelineName: "default",
    projectId: "proj-a",
    runId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-1"),
    stage: makeStage(),
    loopRound: 1,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses-1" as SessionId,
    projectId: "proj-a",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      source: "runtime",
      timestamp: new Date(),
    },
    lifecycle: createInitialCanonicalLifecycle("worker", new Date()),
    branch: "feat/x",
    issueId: null,
    pr: null,
    workspacePath: workspaceRoot,
    runtimeHandle: { id: "tmux-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeMockSessionManager(initial?: Partial<Session>): {
  sm: SessionManager;
  spawn: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setSession: (s: Session | null) => void;
} {
  let current: Session | null = makeSession(initial);
  const spawn = vi.fn(async (_: SessionSpawnConfig): Promise<Session> => {
    if (!current) throw new Error("session manager mock has no session staged");
    return current;
  });
  const get = vi.fn(async (_id: SessionId): Promise<Session | null> => current);
  const kill = vi.fn(
    async (_id: SessionId): Promise<KillResult> => ({ cleaned: true, alreadyTerminated: false }),
  );

  const sm: SessionManager = {
    spawn,
    spawnOrchestrator: vi.fn(),
    ensureOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn(),
    get,
    kill,
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  } as unknown as SessionManager;

  return {
    sm,
    spawn,
    get,
    kill,
    setSession: (s) => {
      current = s;
    },
  };
}

function writeFindingsFile(path: string, lines: string[]): void {
  mkdirSync(join(path, ".ao"), { recursive: true });
  writeFileSync(join(path, STAGE_FINDINGS_RELATIVE_PATH), lines.join("\n") + "\n", "utf-8");
}

describe("agent executor — startStage", () => {
  it("spawns a fresh session with the requested agent and a Layer 4 stage prompt", async () => {
    const mock = makeMockSessionManager();
    const exec = createAgentExecutor({ sessionManager: mock.sm });

    const handle = await exec.startStage(
      makeStartInput({
        issueId: "ISSUE-7",
        stage: makeStage({
          executor: { kind: "agent", plugin: "claude-code", mode: "code" },
          task: { prompt: "implement feature X" },
        }),
      }),
    );

    expect(mock.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mock.spawn.mock.calls[0]?.[0] as SessionSpawnConfig;
    expect(spawnArgs.projectId).toBe("proj-a");
    expect(spawnArgs.agent).toBe("claude-code");
    expect(spawnArgs.issueId).toBe("ISSUE-7");
    // Prompt must include stage descriptor + findings instructions
    expect(spawnArgs.prompt).toContain("Pipeline: default");
    expect(spawnArgs.prompt).toContain("Stage: review");
    expect(spawnArgs.prompt).toContain("implement feature X");
    expect(spawnArgs.prompt).toContain(STAGE_FINDINGS_RELATIVE_PATH);

    expect(handle.sessionId).toBe("ses-1");
    expect(handle.workspacePath).toBe(workspaceRoot);
    expect(handle.stageName).toBe("review");
  });

  it("rejects non-agent stages with AgentExecutorSpawnError", async () => {
    const mock = makeMockSessionManager();
    const exec = createAgentExecutor({ sessionManager: mock.sm });

    await expect(
      exec.startStage(
        makeStartInput({
          stage: makeStage({
            executor: { kind: "command", command: "echo hi" },
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(AgentExecutorSpawnError);
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("wraps session manager spawn failures in AgentExecutorSpawnError", async () => {
    const mock = makeMockSessionManager();
    mock.spawn.mockRejectedValueOnce(new Error("runtime unreachable"));
    const exec = createAgentExecutor({ sessionManager: mock.sm });

    await expect(exec.startStage(makeStartInput())).rejects.toMatchObject({
      name: "AgentExecutorSpawnError",
      message: expect.stringContaining("runtime unreachable"),
    });
  });

  it("kills the session and throws if spawn returns no workspacePath", async () => {
    const mock = makeMockSessionManager({ workspacePath: null });
    const exec = createAgentExecutor({ sessionManager: mock.sm });

    await expect(exec.startStage(makeStartInput())).rejects.toBeInstanceOf(AgentExecutorSpawnError);
    expect(mock.kill).toHaveBeenCalledTimes(1);
  });
});

describe("agent executor — pollStage", () => {
  it("returns running while session is not idle", async () => {
    const mock = makeMockSessionManager({ activity: "active" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    const outcome = await exec.pollStage(handle);
    expect(outcome).toEqual({ status: "running" });
    expect(mock.kill).not.toHaveBeenCalled();
  });

  it("returns running when session is idle but findings file is missing", async () => {
    const mock = makeMockSessionManager({ activity: "idle" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    const outcome = await exec.pollStage(handle);
    expect(outcome).toEqual({ status: "running" });
    expect(mock.kill).not.toHaveBeenCalled();
  });

  it("harvests findings and kills the session when idle + findings file exists", async () => {
    const mock = makeMockSessionManager({ activity: "idle" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    writeFindingsFile(workspaceRoot, [
      JSON.stringify({
        kind: "finding",
        filePath: "src/foo.ts",
        startLine: 10,
        endLine: 12,
        title: "potential null deref",
        description: "x.bar may be null",
        category: "correctness",
        severity: "warning",
        confidence: 0.8,
      }),
      JSON.stringify({ kind: "json", data: { summary: "looks fine" } }),
    ]);

    const outcome = await exec.pollStage(handle);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts).toHaveLength(2);
    expect(outcome.artifacts[0]).toMatchObject({ kind: "finding", title: "potential null deref" });
    expect(outcome.artifacts[1]).toMatchObject({ kind: "json", data: { summary: "looks fine" } });
    expect(mock.kill).toHaveBeenCalledWith(handle.sessionId, { reason: "auto_cleanup" });
  });

  it("treats an empty findings file as a successful completion with zero artifacts", async () => {
    const mock = makeMockSessionManager({ activity: "idle" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    writeFindingsFile(workspaceRoot, []);

    const outcome = await exec.pollStage(handle);
    expect(outcome).toEqual({ status: "completed", artifacts: [] });
    expect(mock.kill).toHaveBeenCalledTimes(1);
  });

  it("returns failed (without killing) when findings file has invalid JSON", async () => {
    const mock = makeMockSessionManager({ activity: "idle" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    writeFindingsFile(workspaceRoot, ["not-json {{{"]);

    const outcome = await exec.pollStage(handle);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("unparseable findings");
    // Bad findings file: leave session up for human inspection
    expect(mock.kill).not.toHaveBeenCalled();
  });

  it("returns failed when the underlying session has vanished between polls", async () => {
    const mock = makeMockSessionManager();
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    mock.setSession(null);
    const outcome = await exec.pollStage(handle);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("no longer exists");
  });

  it("returns failed when the session has exited without producing findings", async () => {
    const mock = makeMockSessionManager({ activity: "exited", status: "killed" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    const outcome = await exec.pollStage(handle);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("terminated without findings");
  });

  it("returns failed when session reaches `done` before findings are harvested", async () => {
    // Regression: stages should never reach `done` ahead of findings — `done`
    // is reserved for post-merge / explicit completion. Treating it as a still-
    // running state would hang the stage forever.
    const mock = makeMockSessionManager({ activity: "idle", status: "done" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    const outcome = await exec.pollStage(handle);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("terminated without findings");
  });

  it("rejects findings whose severity is not in the enum", async () => {
    const mock = makeMockSessionManager({ activity: "idle" });
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    writeFindingsFile(workspaceRoot, [
      JSON.stringify({
        kind: "finding",
        filePath: "src/foo.ts",
        startLine: 1,
        endLine: 1,
        title: "x",
        description: "y",
        category: "general",
        severity: "critical", // not in {"error","warning","info"}
        confidence: 0.5,
      }),
    ]);

    const outcome = await exec.pollStage(handle);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("severity");
    expect(outcome.errorMessage).toContain("critical");
  });
});

describe("agent executor — cancelStage", () => {
  it("kills the underlying session", async () => {
    const mock = makeMockSessionManager();
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    await exec.cancelStage(handle);
    expect(mock.kill).toHaveBeenCalledWith(handle.sessionId, { reason: "auto_cleanup" });
  });

  it("does not throw when the session manager kill fails", async () => {
    const mock = makeMockSessionManager();
    mock.kill.mockRejectedValueOnce(new Error("already gone"));
    const exec = createAgentExecutor({ sessionManager: mock.sm });
    const handle = await exec.startStage(makeStartInput());

    await expect(exec.cancelStage(handle)).resolves.toBeUndefined();
  });
});
