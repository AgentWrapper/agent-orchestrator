/**
 * Pipeline engine — minimum wiring to drive the reducer + agent executor
 * end-to-end for v0.2.
 *
 * Responsibilities:
 *  - Hold engine state in memory (mirrors what's persisted by the store).
 *  - Translate `PipelineEffect`s coming out of the reducer into real I/O:
 *    persistence (PERSIST_RUN, PERSIST_LOOP_STATE, APPEND_ARTIFACTS) and
 *    stage execution (START_STAGE, CANCEL_STAGE).
 *  - On `tick()`, poll every running agent stage; when a stage completes,
 *    dispatch STAGE_COMPLETED back through the reducer.
 *
 * Out of scope for v0.2 (lands later in the pipeline cluster):
 *  - DAG / parallel scheduling (v1.1)
 *  - Command + builtin executors (v1.2)
 *  - SHA / merge-ready trigger detection
 *  - SCM webhook ingestion
 *
 * Tick frequency: there is no internal timer. The caller (lifecycle manager
 * piggybacks on its existing 5s SSE poll, per C-14) drives tick() — no new
 * polling loop is introduced.
 *
 * Concurrency: top-level `dispatch` and `tick` calls are serialized through
 * a single promise-chain lock so concurrent callers (e.g. `cancelRun()`
 * landing while a tick is mid-flight) cannot interleave reads/writes of the
 * in-memory `state`. The engine-internal saga (e.g. START_STAGE → STAGE_STARTED
 * → STAGE_FAILED) routes through `dispatchInline`, which bypasses the lock
 * because it's already running inside it.
 */

import { randomUUID } from "node:crypto";

import type { PluginRegistry } from "../types.js";
import type { PipelineEffect, PipelineEvent } from "./events.js";
import { reduce } from "./reducer.js";
import type { PipelineStore } from "./store.js";
import {
  asRunId,
  asStageRunId,
  emptyEngineState,
  isTerminalLoopState,
  type Artifact,
  type EngineState,
  type Pipeline,
  type RunId,
  type RunState,
  type Stage,
  type StageRunId,
  type StageTriggerEvent,
} from "./types.js";
import { validatePipelineAgentModes, validatePipelineDag } from "./validation.js";
import {
  type AgentStageExecutor,
  type RunningAgentStage,
  type StartStageInput,
} from "./executors/agent.js";

export interface PipelineEngineDeps {
  store: PipelineStore;
  registry: PluginRegistry;
  agentExecutor: AgentStageExecutor;
  /** Optional initial state (e.g. restored from disk on startup). Defaults to empty. */
  initialState?: EngineState;
  /** Override clock for tests. */
  now?: () => number;
}

export interface StartRunInput {
  pipeline: Pipeline;
  projectId: string;
  sessionId: string;
  /** Trigger event that caused this run; defaults to "manual". */
  trigger?: StageTriggerEvent;
  /** SHA tracked for `NEW_SHA_DETECTED` reconciliation. Use "manual" if unknown. */
  headSha: string;
  /** Optional issue id forwarded into spawned sessions. */
  issueId?: string;
}

export interface PipelineEngine {
  /** Current engine state (read-only snapshot). */
  state(): EngineState;

  /**
   * Validate the pipeline against the plugin registry, then dispatch a
   * TRIGGER_FIRED event. Throws PipelineConfigError on validation failure.
   * Returns the allocated run id.
   */
  startRun(input: StartRunInput): Promise<RunId>;

  /**
   * Drive forward any in-flight agent stages. Serialized against `dispatch`
   * and `cancelRun` so concurrent callers cannot race state mutations.
   */
  tick(): Promise<void>;

  /**
   * Dispatch a single event through the reducer and execute its effects.
   * Exposed for tests and for callers that want to inject events directly
   * (e.g. CONFIG_CHANGED from a config watcher). Serialized.
   */
  dispatch(event: PipelineEvent): Promise<void>;

  /** Cancel an in-flight run via RUN_CANCELLED. Idempotent. */
  cancelRun(runId: RunId, reason?: "manual_cancel" | "config_change"): Promise<void>;
}

export function createPipelineEngine(deps: PipelineEngineDeps): PipelineEngine {
  const { store, registry, agentExecutor, now = Date.now } = deps;

  let state: EngineState = deps.initialState ?? emptyEngineState();
  /** stageRunId → executor handle for stages we own. */
  const inflight = new Map<StageRunId, RunningAgentStage>();
  /**
   * Side-table for projectId/issueId, keyed by RunId. The persisted RunState
   * shape was locked by v0.1 and doesn't carry these, so the engine threads
   * them out-of-band into START_STAGE inputs. Pruned by
   * `pruneTerminatedRunMetadata` after every dispatch.
   */
  const runMetadata = new Map<RunId, { projectId: string; issueId?: string }>();

  /**
   * Serialization lock for top-level dispatches. Each public dispatch chains
   * onto `lockTail`; engine-internal recursive dispatches use `dispatchInline`
   * directly because they're already running inside this lock.
   */
  let lockTail: Promise<void> = Promise.resolve();

  function withLock<T>(work: () => Promise<T>): Promise<T> {
    const result = lockTail.then(work);
    // Swallow errors on the chain so one failure doesn't poison subsequent
    // waiters; the original promise (`result`) still rejects to its caller.
    lockTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function dispatch(event: PipelineEvent): Promise<void> {
    // Defense-in-depth: any TRIGGER_FIRED that enters the engine — whether
    // via `startRun`, a test, or a future config-watcher injection — gets
    // the same validation `startRun` applies. Validates synchronously
    // before taking the lock so the error surfaces before any state moves.
    if (event.type === "TRIGGER_FIRED") {
      validatePipelineAgentModes(event.pipeline, registry);
      validatePipelineDag(event.pipeline);
    }
    return withLock(() => dispatchInline(event));
  }

  async function dispatchInline(event: PipelineEvent): Promise<void> {
    const result = reduce(state, event);
    state = result.state;
    for (const effect of result.effects) {
      await executeEffect(effect);
    }
    pruneTerminatedRunMetadata();
  }

  /**
   * Drop side-table entries for runs the reducer has already moved into a
   * terminal loop state. Without this, `runMetadata` grows for the lifetime of
   * the engine — one entry per pipeline run ever started — even though the
   * data is only consumed by START_STAGE on a non-terminal run.
   */
  function pruneTerminatedRunMetadata(): void {
    for (const runId of runMetadata.keys()) {
      const run = state.runs[runId];
      if (!run || isTerminalLoopState(run.loopState)) {
        runMetadata.delete(runId);
      }
    }
  }

  async function executeEffect(effect: PipelineEffect): Promise<void> {
    switch (effect.type) {
      case "PERSIST_RUN":
        store.saveRun(effect.runState);
        for (const [stageName, stageState] of Object.entries(effect.runState.stages)) {
          store.saveStage({ ...stageState, runId: effect.runState.runId, stageName });
        }
        break;

      case "PERSIST_LOOP_STATE":
        store.saveLoopState(effect.runId, effect.loopState);
        break;

      case "APPEND_ARTIFACTS":
        store.appendArtifacts(effect.runId, effect.stageRunId, effect.artifacts);
        break;

      case "START_STAGE": {
        const run = state.runs[effect.runId];
        if (!run) break;
        if (effect.stage.executor.kind !== "agent") {
          // command/builtin executors are out of scope for v0.2 — synthesize
          // a STAGE_FAILED so the run terminates cleanly instead of hanging.
          await dispatchInline({
            type: "STAGE_FAILED",
            now: now(),
            runId: effect.runId,
            stageName: effect.stage.name,
            errorMessage: `Executor kind "${effect.stage.executor.kind}" is not supported in v0.2 (agent executor only).`,
          });
          break;
        }

        // Mark the stage as running BEFORE starting the executor — failures
        // during spawn translate to STAGE_FAILED, which requires running|pending.
        await dispatchInline({
          type: "STAGE_STARTED",
          now: now(),
          runId: effect.runId,
          stageName: effect.stage.name,
        });

        const meta = runMetadata.get(run.runId);
        const siblingArtifacts =
          effect.stage.workspaceClass === "read-siblings"
            ? collectSiblingArtifacts(run, effect.stage)
            : undefined;
        const startInput: StartStageInput = {
          pipelineName: run.pipelineName,
          projectId: meta?.projectId ?? "",
          runId: effect.runId,
          stageRunId: effect.stageRunId,
          stage: effect.stage,
          loopRound: run.loopRounds,
          ...(meta?.issueId ? { issueId: meta.issueId } : {}),
          ...(siblingArtifacts !== undefined ? { siblingArtifacts } : {}),
        };

        try {
          const handle = await agentExecutor.startStage(startInput);
          inflight.set(effect.stageRunId, handle);
        } catch (err) {
          await dispatchInline({
            type: "STAGE_FAILED",
            now: now(),
            runId: effect.runId,
            stageName: effect.stage.name,
            errorMessage:
              err instanceof Error ? err.message : `agent executor failed: ${String(err)}`,
          });
        }
        break;
      }

      case "CANCEL_STAGE": {
        const handle = inflight.get(effect.stageRunId);
        if (handle) {
          inflight.delete(effect.stageRunId);
          try {
            await agentExecutor.cancelStage(handle);
          } catch {
            // Best-effort — handle may already be gone.
          }
        }
        break;
      }

      case "EMIT_OBSERVATION":
        // Engine doesn't own observation routing. v0.2 leaves this as a no-op;
        // a later sub-task (#1629/#1630) wires it into the activity-event log.
        break;
    }
  }

  async function tick(): Promise<void> {
    return withLock(async () => {
      if (inflight.size === 0) return;
      const handles = [...inflight.values()];
      for (const handle of handles) {
        const outcome = await agentExecutor.pollStage(handle);
        if (outcome.status === "running") continue;

        inflight.delete(handle.stageRunId);

        if (outcome.status === "completed") {
          await dispatchInline({
            type: "STAGE_COMPLETED",
            now: now(),
            runId: handle.runId,
            stageName: handle.stageName,
            artifacts: outcome.artifacts,
          });
        } else {
          await dispatchInline({
            type: "STAGE_FAILED",
            now: now(),
            runId: handle.runId,
            stageName: handle.stageName,
            errorMessage: outcome.errorMessage,
          });
        }
      }
    });
  }

  async function startRun(input: StartRunInput): Promise<RunId> {
    // Validate exactly once. Calling `dispatch` here would re-validate
    // inside the lock, opening a window where the registry could mutate
    // between the two synchronous checks — if the second throws, the
    // `runMetadata.set` below would have already populated an orphan entry
    // with no matching run. Instead we validate up front and skip
    // `dispatch`'s validation by going through `withLock(dispatchInline)`
    // directly.
    validatePipelineAgentModes(input.pipeline, registry);
    validatePipelineDag(input.pipeline);

    const runId = asRunId(`run-${randomUUID()}`);
    const stageRunIds: Record<string, StageRunId> = {};
    for (const stage of input.pipeline.stages) {
      stageRunIds[stage.name] = asStageRunId(`sr-${randomUUID()}`);
    }

    // Stash projectId/issueId BEFORE dispatch so the START_STAGE effect — which
    // fires synchronously inside the same dispatch — can read them. The
    // persisted RunState shape was locked by v0.1, so we carry these out-of-band.
    runMetadata.set(runId, {
      projectId: input.projectId,
      issueId: input.issueId,
    });

    await withLock(() =>
      dispatchInline({
        type: "TRIGGER_FIRED",
        now: now(),
        trigger: input.trigger ?? "manual",
        sessionId: input.sessionId,
        pipeline: input.pipeline,
        headSha: input.headSha,
        runId,
        stageRunIds,
      }),
    );

    return runId;
  }

  async function cancelRun(
    runId: RunId,
    reason: "manual_cancel" | "config_change" = "manual_cancel",
  ): Promise<void> {
    if (!state.runs[runId]) return;
    await dispatch({ type: "RUN_CANCELLED", now: now(), runId, reason });
  }

  return {
    state: () => state,
    startRun,
    tick,
    dispatch,
    cancelRun,
  };
}

/**
 * Collect artifacts from upstream stages a `read-siblings` stage should see.
 * Upstream = the transitive closure of `dependsOn`. Routes references aren't
 * included here because they're activation gates, not data dependencies — a
 * stage that reacts to a sibling's *failure* doesn't necessarily want to read
 * the sibling's artifacts.
 *
 * Returns an object keyed by upstream stage name. Stages that produced no
 * artifacts (yet) are omitted to keep the prompt block compact.
 */
function collectSiblingArtifacts(run: RunState, stage: Stage): Record<string, Artifact[]> {
  const buffer = run.runArtifacts ?? {};
  const visited = new Set<string>();
  const queue: string[] = [...(stage.dependsOn ?? [])];
  const stagesByName = new Map<string, Stage>();
  for (const s of run.pipelineConfigSnapshot.stages) stagesByName.set(s.name, s);

  const out: Record<string, Artifact[]> = {};
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const artifacts = buffer[name];
    if (artifacts && artifacts.length > 0) out[name] = artifacts;
    const upstream = stagesByName.get(name)?.dependsOn ?? [];
    for (const next of upstream) if (!visited.has(next)) queue.push(next);
  }
  return out;
}
