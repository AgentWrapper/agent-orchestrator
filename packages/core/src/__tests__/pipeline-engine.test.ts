/**
 * End-to-end pipeline engine test: a 1-stage pipeline triggered programmatically
 * runs through start → poll → completion, and findings are persisted to the
 * artifact store. The agent executor is mocked so the engine can be exercised
 * without spinning up a real session.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asPipelineId,
  createPipelineEngine,
  createPipelineStore,
  loopKey,
  PipelineConfigError,
  type AgentStageExecutor,
  type ArtifactInput,
  type Pipeline,
  type RunningAgentStage,
  type Stage,
  type StageOutcome,
  type StartStageInput,
  type TaskMode,
} from "../pipeline/index.js";
import { createPluginRegistry } from "../plugin-registry.js";
import type { Agent, PluginManifest, PluginModule, PluginRegistry } from "../types.js";

let storeRoot: string;

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "pipeline-engine-"));
});

afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true });
});

function makeAgentPlugin(name: string, modes: TaskMode[]): PluginModule<Agent> {
  const manifest: PluginManifest = {
    name,
    slot: "agent",
    description: "test",
    version: "0.0.0",
    supportedTaskModes: modes,
  };
  return {
    manifest,
    create: () =>
      ({
        name,
        processName: name,
        getLaunchCommand: () => "true",
        getEnvironment: () => ({}),
        detectActivity: () => "idle",
        getActivityState: async () => null,
        isProcessRunning: async () => true,
        getSessionInfo: async () => null,
      }) as Agent,
  };
}

function withRegistry(plugins: PluginModule[]): PluginRegistry {
  const r = createPluginRegistry();
  for (const p of plugins) r.register(p);
  return r;
}

function makeStage(overrides: Partial<Stage> = {}): Stage {
  return {
    name: "review",
    trigger: { on: ["pr.opened"] },
    executor: { kind: "agent", plugin: "codex", mode: "review" },
    task: { prompt: "review" },
    ...overrides,
  };
}

function makePipeline(stages: Stage[] = [makeStage()]): Pipeline {
  return { id: asPipelineId("pl-1"), name: "default", stages, maxConcurrentStages: 1 };
}

interface MockExecutor extends AgentStageExecutor {
  startCalls: StartStageInput[];
  killed: string[];
  setNextOutcome: (outcome: StageOutcome) => void;
}

function makeMockExecutor(): MockExecutor {
  let nextOutcome: StageOutcome = { status: "running" };
  const startCalls: StartStageInput[] = [];
  const killed: string[] = [];

  const exec: MockExecutor = {
    startCalls,
    killed,
    setNextOutcome: (o) => {
      nextOutcome = o;
    },
    async startStage(input: StartStageInput): Promise<RunningAgentStage> {
      startCalls.push(input);
      return {
        runId: input.runId,
        stageRunId: input.stageRunId,
        stageName: input.stage.name,
        sessionId: `mock-ses-${startCalls.length}`,
        workspacePath: "/tmp/mock",
        startedAt: Date.now(),
        input,
      };
    },
    async pollStage(_handle: RunningAgentStage): Promise<StageOutcome> {
      return nextOutcome;
    },
    async cancelStage(handle: RunningAgentStage): Promise<void> {
      killed.push(handle.sessionId);
    },
  };
  return exec;
}

describe("pipeline engine — end-to-end", () => {
  it("runs a 1-stage pipeline from trigger → completion → artifact persistence", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: executor,
    });

    const runId = await engine.startRun({
      pipeline: makePipeline(),
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    // After startRun, the stage should be running (executor was called)
    expect(executor.startCalls).toHaveLength(1);
    expect(executor.startCalls[0]?.projectId).toBe("proj-a");
    expect(executor.startCalls[0]?.stage.name).toBe("review");

    // The reducer marked the stage as running and persisted the run
    const persistedAfterStart = store.loadRun(runId);
    expect(persistedAfterStart?.stages["review"]?.status).toBe("running");

    // Stage still running on tick — engine state unchanged
    await engine.tick();
    expect(store.loadRun(runId)?.stages["review"]?.status).toBe("running");

    // Stage completes — engine harvests on next tick
    const finding: ArtifactInput = {
      kind: "finding",
      filePath: "src/foo.ts",
      startLine: 1,
      endLine: 1,
      title: "x",
      description: "y",
      category: "general",
      severity: "info",
      confidence: 1,
    };
    executor.setNextOutcome({ status: "completed", artifacts: [finding] });
    await engine.tick();

    const finalRun = store.loadRun(runId)!;
    expect(finalRun.stages["review"]?.status).toBe("succeeded");
    expect(finalRun.loopState).toBe("done");
    expect(finalRun.terminationReason).toBe("completed");

    // Findings landed on disk via APPEND_ARTIFACTS
    const stageRunId = finalRun.stages["review"]!.stageRunId;
    const stored = store.listArtifacts(runId, stageRunId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "finding", title: "x", status: "open" });

    // Loop key freed after run terminates
    expect(engine.state().currentRunByLoop[loopKey("ses-1", "default")]).toBeUndefined();
  });

  it("propagates executor failures as STAGE_FAILED → run stalled", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();

    const engine = createPipelineEngine({
      store,
      registry,
      agentExecutor: executor,
    });

    const runId = await engine.startRun({
      pipeline: makePipeline(),
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    executor.setNextOutcome({ status: "failed", errorMessage: "agent crashed" });
    await engine.tick();

    const run = store.loadRun(runId)!;
    expect(run.stages["review"]?.status).toBe("failed");
    expect(run.stages["review"]?.errorMessage).toBe("agent crashed");
    expect(run.loopState).toBe("stalled");
    expect(run.terminationReason).toBe("stage_failure");
  });

  it("rejects pipelines whose agent does not advertise the requested mode", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["code"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    await expect(
      engine.startRun({
        pipeline: makePipeline(),
        projectId: "proj-a",
        sessionId: "ses-1",
        headSha: "sha",
      }),
    ).rejects.toBeInstanceOf(PipelineConfigError);
    expect(executor.startCalls).toHaveLength(0);
  });

  it("rejects programmatic pipelines with a stage dependency cycle", async () => {
    // Programmatic Pipeline construction skips Zod, so the engine must defend
    // against cycles itself — otherwise the run would deadlock with every
    // cycle member stuck `pending` forever.
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    const cyclic: Pipeline = {
      id: asPipelineId("cyclic"),
      name: "cyclic",
      stages: [
        makeStage({ name: "a", dependsOn: ["b"] }),
        makeStage({ name: "b", dependsOn: ["a"] }),
      ],
      maxConcurrentStages: 1,
    };

    await expect(
      engine.startRun({
        pipeline: cyclic,
        projectId: "proj-a",
        sessionId: "ses-1",
        headSha: "sha",
      }),
    ).rejects.toBeInstanceOf(PipelineConfigError);
    expect(executor.startCalls).toHaveLength(0);
  });

  it("validates pipelines on direct engine.dispatch(TRIGGER_FIRED)", async () => {
    // Tests and a future config-watcher path can dispatch arbitrary events.
    // engine.dispatch must apply the same validation as engine.startRun so
    // callers can't silently inject a deadlocked TRIGGER_FIRED.
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    const cyclic: Pipeline = {
      id: asPipelineId("cyclic-dispatch"),
      name: "cyclic-dispatch",
      stages: [
        makeStage({ name: "a", dependsOn: ["b"] }),
        makeStage({ name: "b", dependsOn: ["a"] }),
      ],
      maxConcurrentStages: 1,
    };

    await expect(
      engine.dispatch({
        type: "TRIGGER_FIRED",
        now: Date.now(),
        trigger: "manual",
        sessionId: "ses-1",
        pipeline: cyclic,
        headSha: "sha",
        runId: "run-x" as ReturnType<typeof asPipelineId> as never,
        stageRunIds: {},
      } as never),
    ).rejects.toBeInstanceOf(PipelineConfigError);
    expect(executor.startCalls).toHaveLength(0);
  });

  it("synthesizes STAGE_FAILED for non-agent executor kinds (v0.2 only supports agent)", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    const pipeline = makePipeline([
      makeStage({
        name: "lint",
        trigger: { on: ["pr.opened"] },
        executor: { kind: "command", command: "eslint" },
        task: {},
      }),
    ]);

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha",
    });

    const run = store.loadRun(runId)!;
    expect(run.stages["lint"]?.status).toBe("failed");
    expect(run.stages["lint"]?.errorMessage).toContain("not supported in v0.2");
    expect(executor.startCalls).toHaveLength(0);
  });

  it("cancelRun terminates an in-flight run and cancels the executor", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    const runId = await engine.startRun({
      pipeline: makePipeline(),
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha",
    });

    await engine.cancelRun(runId);

    const run = store.loadRun(runId)!;
    expect(run.terminationReason).toBe("manual_cancel");
    expect(run.loopState).toBe("terminated");
    expect(executor.killed).toHaveLength(1);
  });

  it("tick is a no-op when nothing is in flight", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const pollSpy = vi.spyOn(executor, "pollStage");
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    await engine.tick();
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it("runs a multi-stage pipeline sequentially (serial scheduling, maxConcurrentStages=1)", async () => {
    const registry = withRegistry([makeAgentPlugin("codex", ["review", "code"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    const pipeline = makePipeline([
      makeStage({ name: "review" }),
      makeStage({
        name: "fix",
        executor: { kind: "agent", plugin: "codex", mode: "code" },
      }),
    ]);

    const runId = await engine.startRun({
      pipeline,
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    // Only the first stage should be running at this point — maxConcurrentStages=1
    expect(executor.startCalls).toHaveLength(1);
    expect(executor.startCalls[0]?.stage.name).toBe("review");

    // Complete stage 1 — engine should immediately schedule stage 2
    executor.setNextOutcome({ status: "completed", artifacts: [] });
    await engine.tick();

    expect(executor.startCalls).toHaveLength(2);
    expect(executor.startCalls[1]?.stage.name).toBe("fix");

    // Complete stage 2 — run reaches `done`
    executor.setNextOutcome({ status: "completed", artifacts: [] });
    await engine.tick();

    const finalRun = store.loadRun(runId)!;
    expect(finalRun.stages["review"]?.status).toBe("succeeded");
    expect(finalRun.stages["fix"]?.status).toBe("succeeded");
    expect(finalRun.loopState).toBe("done");
  });

  it("serializes top-level dispatches: cancelRun launched mid-tick observes the post-tick state", async () => {
    // Without serialization, cancelRun's reduce() reads `state` while tick's
    // reduce() is mid-update. With the lock, cancel waits for tick to finish
    // its dispatchInline chain — so the state cancel sees is the one tick
    // produced (run already in `done`), and cancel becomes a no-op.
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);

    let pollResolve: (() => void) | null = null;
    const executor: AgentStageExecutor = {
      async startStage(input) {
        return {
          runId: input.runId,
          stageRunId: input.stageRunId,
          stageName: input.stage.name,
          sessionId: "ses-1",
          workspacePath: "/tmp",
          startedAt: Date.now(),
          input,
        };
      },
      async pollStage(_handle): Promise<StageOutcome> {
        await new Promise<void>((resolve) => {
          pollResolve = resolve;
        });
        return { status: "completed", artifacts: [] };
      },
      async cancelStage() {},
    };

    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });
    const runId = await engine.startRun({
      pipeline: makePipeline(),
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });

    // Kick off a tick that will block on pollStage
    const tickPromise = engine.tick();
    // Yield so the tick's `pollStage` is actually awaiting
    await new Promise((r) => setTimeout(r, 0));
    // Now fire cancelRun — must NOT execute until tick releases the lock
    const cancelPromise = engine.cancelRun(runId);
    // Release pollStage → tick completes → run reaches `done` → cancel runs
    pollResolve!();
    await tickPromise;
    await cancelPromise;

    const finalRun = store.loadRun(runId)!;
    // Tick completed first (lock acquired first) so the run is `done`,
    // not `terminated`. Cancel ran on a terminal run — no-op.
    expect(finalRun.loopState).toBe("done");
    expect(finalRun.terminationReason).toBe("completed");
  });

  it("subsequent runs against the same loop key still receive their projectId after the prior run terminated", async () => {
    // Regression: the engine prunes its run-metadata side-table when a run
    // reaches a terminal loop state. A naive implementation that pruned the
    // map immediately on dispatch would also wipe the *next* run's entry
    // before START_STAGE could read it. Verify that a second run started
    // after the first completes still spawns with the correct projectId.
    const registry = withRegistry([makeAgentPlugin("codex", ["review"])]);
    const store = createPipelineStore(storeRoot);
    const executor = makeMockExecutor();
    const engine = createPipelineEngine({ store, registry, agentExecutor: executor });

    // Run 1: start, complete, tick to terminal
    await engine.startRun({
      pipeline: makePipeline(),
      projectId: "proj-a",
      sessionId: "ses-1",
      headSha: "sha-aaa",
    });
    executor.setNextOutcome({ status: "completed", artifacts: [] });
    await engine.tick();

    // Run 2: same loop key, fresh SHA
    executor.setNextOutcome({ status: "running" });
    await engine.startRun({
      pipeline: makePipeline(),
      projectId: "proj-b",
      sessionId: "ses-1",
      headSha: "sha-bbb",
    });

    expect(executor.startCalls).toHaveLength(2);
    expect(executor.startCalls[1]?.projectId).toBe("proj-b");
  });
});
