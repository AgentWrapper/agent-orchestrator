/**
 * Engine-level integration tests for the v1.2 executors.
 *
 * Verifies that command, builtin/router, and builtin/compose stages are
 * wired into the engine end-to-end:
 *   - Multi-stage DAG: lint (command) → compose → router → target session.
 *   - Fork-PR refusal at the engine boundary (command stage marks the run
 *     stalled with the documented refusal message).
 *   - Router stage actually invokes the sendToSession callback with a
 *     payload that contains the upstream findings.
 *   - Compose stage merges two upstream stages into a single composite.
 *
 * Agent executor is mocked so we can drive the engine without sessions.
 *
 * Tests spawn real subprocesses via `/bin/sh -c` with POSIX syntax. The
 * whole file is gated on POSIX hosts; the no-subprocess executor unit
 * tests in pipeline-command-executor.test.ts cover the cross-platform
 * surface (guards, fork refusal, kind mismatch).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isWindows } from "../platform.js";
import {
  asPipelineId,
  createBuiltinComposeExecutor,
  createBuiltinRouterExecutor,
  createCommandExecutor,
  createPipelineEngine,
  createPipelineStore,
  formatForkRefusalMessage,
  isTerminalLoopState,
  type AgentStageExecutor,
  type Pipeline,
  type PipelineEngine,
  type RunId,
  type RunningAgentStage,
  type Stage,
  type StageOutcome,
  type StartStageInput,
} from "../pipeline/index.js";
import { createPluginRegistry } from "../plugin-registry.js";
import type { Agent, PluginManifest, PluginModule } from "../types.js";

/**
 * Poll the engine until the run reaches a terminal loop state (done / stalled
 * / terminated). Command stages now use the non-blocking pattern — they're in
 * commandInflight after startRun and only complete after tick() harvests the
 * exited child. Fast subprocesses (true, echo) typically finish in one or two
 * ticks; we cap at 200 iterations (≈10s) to avoid hanging on flaky hosts.
 */
async function tickUntilDone(
  engine: PipelineEngine,
  runId: RunId,
  maxTicks = 200,
  intervalMs = 50,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const runState = engine.state().runs[runId];
    if (runState && isTerminalLoopState(runState.loopState)) return;
    await engine.tick();
    // Brief yield so the child process has a chance to exit between ticks.
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  // One final tick in case the process exited during the last sleep.
  await engine.tick();
}

const posixDescribe = isWindows() ? describe.skip : describe;

let storeRoot: string;

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "pipeline-engine-exec-"));
});

afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true });
});

function makeAgentPlugin(): PluginModule<Agent> {
  const manifest: PluginManifest = {
    name: "codex",
    slot: "agent",
    description: "test",
    version: "0.0.0",
    supportedTaskModes: ["review", "code", "answer"],
  };
  return {
    manifest,
    create: () =>
      ({
        name: "codex",
        processName: "codex",
        getLaunchCommand: () => "true",
        getEnvironment: () => ({}),
        detectActivity: () => "idle",
        getActivityState: async () => null,
        isProcessRunning: async () => true,
        getSessionInfo: async () => null,
      }) as Agent,
  };
}

function noopAgentExecutor(): AgentStageExecutor {
  return {
    async startStage(input: StartStageInput): Promise<RunningAgentStage> {
      return {
        runId: input.runId,
        stageRunId: input.stageRunId,
        stageName: input.stage.name,
        sessionId: "mock-ses",
        workspacePath: "/tmp/mock",
        startedAt: Date.now(),
        input,
      };
    },
    async pollStage(): Promise<StageOutcome> {
      return { status: "running" };
    },
    async cancelStage(): Promise<void> {
      // no-op
    },
  };
}

function makeCommandStage(name: string, command: string, overrides: Partial<Stage> = {}): Stage {
  return {
    name,
    trigger: { on: ["manual"] },
    executor: { kind: "command", command: "/bin/sh", args: ["-c", command] },
    task: {},
    ...overrides,
  };
}

posixDescribe("engine + command executor", () => {
  it("runs a command stage to completion and persists its findings", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
    });

    const finding = {
      kind: "finding" as const,
      filePath: "src/x.ts",
      startLine: 1,
      endLine: 1,
      title: "lint-finding",
      description: "demo",
      category: "general",
      severity: "info" as const,
      confidence: 0.5,
    };
    const pipeline: Pipeline = {
      id: asPipelineId("pl-cmd"),
      name: "cmd",
      stages: [
        makeCommandStage(
          "lint",
          `printf '%s' ${JSON.stringify(JSON.stringify(finding))}`,
        ),
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    await tickUntilDone(engine, runId);

    const run = store.loadRun(runId);
    expect(run?.stages["lint"]?.status).toBe("succeeded");
    const stageRunId = run?.stages["lint"]?.stageRunId;
    if (!stageRunId) throw new Error("no stageRunId");
    const artifacts = store.listArtifacts(runId, stageRunId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "finding", title: "lint-finding" });
  });

  it("refuses command stages on fork PRs unless allowFork: true", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-fork"),
      name: "fork",
      stages: [makeCommandStage("scan", "echo should-not-run")],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-fork",
      isFromFork: true,
    });

    // Fork refusal settles synchronously inside startRun (no subprocess),
    // so a single tick is sufficient to confirm the terminal state.
    await engine.tick();

    const run = store.loadRun(runId);
    expect(run?.stages["scan"]?.status).toBe("failed");
    expect(run?.stages["scan"]?.errorMessage).toBe(formatForkRefusalMessage("scan"));
    // Run terminates as stalled on stage failure (per v1.1 reducer semantics).
    expect(run?.loopState).toBe("stalled");
  });

  it("runs a command stage on a fork PR when allowFork: true", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-fork-ok"),
      name: "fork-ok",
      stages: [makeCommandStage("scan", "true", { allowFork: true })],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-fork",
      isFromFork: true,
    });

    await tickUntilDone(engine, runId);

    const run = store.loadRun(runId);
    expect(run?.stages["scan"]?.status).toBe("succeeded");
  });
});

posixDescribe("engine + builtin/router", () => {
  it("delivers upstream findings to a target session via sendToSession", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const sendToSession = vi.fn(async (_id: string, _payload: string) => undefined);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
      builtinRouter: createBuiltinRouterExecutor(),
      sendToSession,
    });

    const finding = {
      kind: "finding" as const,
      filePath: "src/x.ts",
      startLine: 1,
      endLine: 1,
      title: "router-finding",
      description: "demo",
      category: "general",
      severity: "warning" as const,
      confidence: 0.9,
    };

    const pipeline: Pipeline = {
      id: asPipelineId("pl-router"),
      name: "router-pipe",
      stages: [
        makeCommandStage("lint", `printf '%s' ${JSON.stringify(JSON.stringify(finding))}`),
        {
          name: "deliver",
          trigger: { on: ["manual"] },
          executor: {
            kind: "builtin/router",
            fromStages: ["lint"],
            target: { kind: "session", sessionId: "ses-target" },
          },
          task: {},
          dependsOn: ["lint"],
        },
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-self",
      headSha: "sha-aaa",
    });

    await tickUntilDone(engine, runId);

    const run = store.loadRun(runId);
    expect(run?.stages["lint"]?.status).toBe("succeeded");
    expect(run?.stages["deliver"]?.status).toBe("succeeded");
    expect(run?.loopState).toBe("done");

    expect(sendToSession).toHaveBeenCalledTimes(1);
    const [target, payload] = sendToSession.mock.calls[0];
    expect(target).toBe("ses-target");
    expect(payload).toContain("Pipeline routing: router-pipe → deliver");
    expect(payload).toContain("router-finding");
  });

  it("resolves target.kind: 'self' to the run's session id", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const sendToSession = vi.fn(async () => undefined);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
      builtinRouter: createBuiltinRouterExecutor(),
      sendToSession,
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-router-self"),
      name: "router-self",
      stages: [
        makeCommandStage("lint", "true"),
        {
          name: "deliver",
          trigger: { on: ["manual"] },
          executor: {
            kind: "builtin/router",
            fromStages: ["lint"],
            target: { kind: "self" },
          },
          task: {},
          dependsOn: ["lint"],
        },
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-run-owner",
      headSha: "sha-aaa",
    });

    await tickUntilDone(engine, runId);

    expect(sendToSession).toHaveBeenCalledWith("ses-run-owner", expect.any(String));
  });
});

posixDescribe("engine + builtin/compose", () => {
  it("merges findings from two upstream stages into a single composite artifact", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
      builtinCompose: createBuiltinComposeExecutor(),
    });

    const lintFinding = {
      kind: "finding" as const,
      filePath: "a.ts",
      startLine: 1,
      endLine: 1,
      title: "lint-A",
      description: "d",
      category: "c",
      severity: "info" as const,
      confidence: 0.4,
    };
    const scanFinding = {
      kind: "finding" as const,
      filePath: "b.ts",
      startLine: 5,
      endLine: 6,
      title: "scan-A",
      description: "d",
      category: "c",
      severity: "error" as const,
      confidence: 1,
    };

    const pipeline: Pipeline = {
      id: asPipelineId("pl-compose"),
      name: "compose-pipe",
      stages: [
        makeCommandStage("lint", `printf '%s' ${JSON.stringify(JSON.stringify(lintFinding))}`),
        makeCommandStage("scan", `printf '%s' ${JSON.stringify(JSON.stringify(scanFinding))}`),
        {
          name: "merge",
          trigger: { on: ["manual"] },
          executor: { kind: "builtin/compose", fromStages: ["lint", "scan"] },
          task: {},
          dependsOn: ["lint", "scan"],
        },
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    await tickUntilDone(engine, runId);

    const run = store.loadRun(runId);
    expect(run?.stages["merge"]?.status).toBe("succeeded");
    expect(run?.loopState).toBe("done");

    const mergeStageRunId = run?.stages["merge"]?.stageRunId;
    if (!mergeStageRunId) throw new Error("missing stageRunId");
    const composites = store.listArtifacts(runId, mergeStageRunId);
    expect(composites).toHaveLength(1);
    const composite = composites[0];
    expect(composite.kind).toBe("json");
    if (composite.kind !== "json") throw new Error("unreachable");
    expect(composite.data).toMatchObject({
      builtin: "compose",
      sourceStages: ["lint", "scan"],
      bundles: [
        { stage: "lint", count: 1 },
        { stage: "scan", count: 1 },
      ],
    });
  });
});

posixDescribe("engine + builtin executors — guardrails", () => {
  it("fails a builtin/router stage when sendToSession is not configured", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
      builtinRouter: createBuiltinRouterExecutor(),
      // sendToSession intentionally omitted
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-router-missing"),
      name: "router-missing",
      stages: [
        makeCommandStage("dummy", "true"),
        {
          name: "deliver",
          trigger: { on: ["manual"] },
          executor: {
            kind: "builtin/router",
            fromStages: ["dummy"],
            target: { kind: "self" },
          },
          task: {},
          dependsOn: ["dummy"],
        },
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    await tickUntilDone(engine, runId);

    const run = store.loadRun(runId);
    expect(run?.stages["dummy"]?.status).toBe("succeeded");
    expect(run?.stages["deliver"]?.status).toBe("failed");
    expect(run?.stages["deliver"]?.errorMessage).toContain("sendToSession");
  });

  it("fails a command stage when commandExecutor is not configured", async () => {
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      // commandExecutor intentionally omitted
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-no-cmd"),
      name: "no-cmd",
      stages: [makeCommandStage("lint", "true")],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    // No subprocess — failure is instant. One tick is enough to confirm.
    await engine.tick();

    const run = store.loadRun(runId);
    expect(run?.stages["lint"]?.status).toBe("failed");
    expect(run?.stages["lint"]?.errorMessage).toContain("command executor not configured");
  });

  it("converts a thrown builtin executor exception into STAGE_FAILED (no stuck stage)", async () => {
    // Regression: if a builtin executor's `run()` rejects (rather than
    // returning `{ status: "failed" }`), the engine must still terminate
    // the stage cleanly. Without the engine-side try/catch, the stage
    // stays permanently `running` and the whole run stalls.
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    // Custom builtin that always throws.
    const throwingRouter = {
      async run(): Promise<never> {
        throw new Error("simulated executor crash");
      },
    };

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
      builtinRouter: throwingRouter,
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-throwing-router"),
      name: "throwing-router",
      stages: [
        makeCommandStage("upstream", "true"),
        {
          name: "deliver",
          trigger: { on: ["manual"] },
          executor: {
            kind: "builtin/router",
            fromStages: ["upstream"],
            target: { kind: "self" },
          },
          task: {},
          dependsOn: ["upstream"],
        },
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    await tickUntilDone(engine, runId);

    const run = store.loadRun(runId);
    expect(run?.stages["deliver"]?.status).toBe("failed");
    expect(run?.stages["deliver"]?.errorMessage).toContain("simulated executor crash");
    expect(run?.loopState).toBe("stalled");
  });
});

posixDescribe("engine + command executor — non-blocking handoff", () => {
  it("does not block cancelRun / tick / parallel stages during a long-running command stage", async () => {
    // Pipeline: two parallel `sleep 5` command stages (no dependsOn).
    // After startRun returns, both should be in commandInflight (running).
    // cancelRun should complete in <500ms (not have to wait for sleep to finish).
    // After cancel, the run state should be 'terminated' and stages 'outdated' or 'failed'.
    const registry = createPluginRegistry();
    registry.register(makeAgentPlugin());
    const store = createPipelineStore(storeRoot);

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: noopAgentExecutor(),
      commandExecutor: createCommandExecutor(),
    });

    const pipeline: Pipeline = {
      id: asPipelineId("pl-nonblock"),
      name: "nonblock",
      stages: [
        makeCommandStage("stage-a", "sleep 5"),
        makeCommandStage("stage-b", "sleep 5"),
      ],
    };

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-nb",
    });

    // After startRun the stages must be running (lock was released immediately
    // after spawn — the children are alive in commandInflight).
    const runAfterStart = engine.state().runs[runId];
    expect(runAfterStart?.loopState).toBe("running");

    // cancelRun must complete far faster than the 5s sleep.
    const cancelStart = Date.now();
    await engine.cancelRun(runId);
    const cancelElapsed = Date.now() - cancelStart;
    expect(cancelElapsed).toBeLessThan(500);

    // The run must be in a terminal state.
    const runAfterCancel = engine.state().runs[runId];
    expect(isTerminalLoopState(runAfterCancel?.loopState ?? "running")).toBe(true);
  }, 10_000); // generous wall-clock budget; the cancel itself must be <500ms
});
