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
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asPipelineId,
  createBuiltinComposeExecutor,
  createBuiltinRouterExecutor,
  createCommandExecutor,
  createPipelineEngine,
  createPipelineStore,
  formatForkRefusalMessage,
  type AgentStageExecutor,
  type Pipeline,
  type RunningAgentStage,
  type Stage,
  type StageOutcome,
  type StartStageInput,
} from "../pipeline/index.js";
import { createPluginRegistry } from "../plugin-registry.js";
import type { Agent, PluginManifest, PluginModule } from "../types.js";

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

describe("engine + command executor", () => {
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

    const run = store.loadRun(runId);
    expect(run?.stages["scan"]?.status).toBe("succeeded");
  });
});

describe("engine + builtin/router", () => {
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

    await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-run-owner",
      headSha: "sha-aaa",
    });

    expect(sendToSession).toHaveBeenCalledWith("ses-run-owner", expect.any(String));
  });
});

describe("engine + builtin/compose", () => {
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

describe("engine + builtin executors — guardrails", () => {
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

    const run = store.loadRun(runId);
    expect(run?.stages["lint"]?.status).toBe("failed");
    expect(run?.stages["lint"]?.errorMessage).toContain("command executor not configured");
  });
});
