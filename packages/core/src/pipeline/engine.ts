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
  type BuiltinTaskContext,
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
import type { BuiltinExecutor } from "./executors/builtin-router.js";
import type { CommandStageExecutor, CommandStartInput } from "./executors/command.js";

export interface PipelineEngineDeps {
  store: PipelineStore;
  registry: PluginRegistry;
  agentExecutor: AgentStageExecutor;
  /**
   * Required for `command` stages. When omitted, a `command` stage fails with
   * a clear "command executor not configured" error rather than hanging.
   */
  commandExecutor?: CommandStageExecutor;
  /** Required for `builtin/router` stages. */
  builtinRouter?: BuiltinExecutor;
  /** Required for `builtin/compose` stages. */
  builtinCompose?: BuiltinExecutor;
  /**
   * Callback used by `builtin/router` to deliver payloads to a target
   * session. Typically `(id, msg) => sessionManager.send(asSessionId(id), msg)`.
   * Without it, router stages fail with "sendToSession not configured".
   */
  sendToSession?(sessionId: string, payload: string): Promise<void>;
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
  /**
   * True when the triggering PR is from a fork. Forwarded into the command
   * executor so it can enforce the fork-safety opt-in (`Stage.allowFork`).
   * Defaults to `false` for non-PR runs (manual triggers).
   */
  isFromFork?: boolean;
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
  const {
    store,
    registry,
    agentExecutor,
    commandExecutor,
    builtinRouter,
    builtinCompose,
    sendToSession,
    now = Date.now,
  } = deps;

  let state: EngineState = deps.initialState ?? emptyEngineState();
  /** stageRunId → executor handle for stages we own. */
  const inflight = new Map<StageRunId, RunningAgentStage>();
  /**
   * Side-table for projectId/issueId/isFromFork, keyed by RunId. The persisted
   * RunState shape was locked by v0.1 and doesn't carry these, so the engine
   * threads them out-of-band into START_STAGE inputs. Pruned by
   * `pruneTerminatedRunMetadata` after every dispatch.
   */
  const runMetadata = new Map<
    RunId,
    { projectId: string; issueId?: string; isFromFork: boolean }
  >();

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

        // Mark the stage as running BEFORE handing off to an executor —
        // failures during spawn translate to STAGE_FAILED, which requires
        // running|pending. The reducer guards against double-START so this
        // is safe even when the executor completes synchronously.
        await dispatchInline({
          type: "STAGE_STARTED",
          now: now(),
          runId: effect.runId,
          stageName: effect.stage.name,
        });

        const meta = runMetadata.get(run.runId);
        const kind = effect.stage.executor.kind;
        if (kind === "agent") {
          await runAgentStage(run, effect.runId, effect.stageRunId, effect.stage, meta);
        } else if (kind === "command") {
          await runCommandStage(run, effect.runId, effect.stage, meta);
        } else if (kind === "builtin/router" || kind === "builtin/compose") {
          await runBuiltinStage(run, effect.runId, effect.stageRunId, effect.stage);
        } else {
          await dispatchInline({
            type: "STAGE_FAILED",
            now: now(),
            runId: effect.runId,
            stageName: effect.stage.name,
            errorMessage: `Executor kind "${kind}" is not supported.`,
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

  async function runAgentStage(
    run: RunState,
    runId: RunId,
    stageRunId: StageRunId,
    stage: Stage,
    meta: { projectId: string; issueId?: string } | undefined,
  ): Promise<void> {
    const startInput: StartStageInput = {
      pipelineName: run.pipelineName,
      projectId: meta?.projectId ?? "",
      runId,
      stageRunId,
      stage,
      loopRound: run.loopRounds,
      ...(meta?.issueId ? { issueId: meta.issueId } : {}),
    };

    try {
      const handle = await agentExecutor.startStage(startInput);
      inflight.set(stageRunId, handle);
    } catch (err) {
      await dispatchInline({
        type: "STAGE_FAILED",
        now: now(),
        runId,
        stageName: stage.name,
        errorMessage:
          err instanceof Error ? err.message : `agent executor failed: ${String(err)}`,
      });
    }
  }

  async function runCommandStage(
    run: RunState,
    runId: RunId,
    stage: Stage,
    meta: { projectId: string; issueId?: string; isFromFork: boolean } | undefined,
  ): Promise<void> {
    if (!commandExecutor) {
      await dispatchInline({
        type: "STAGE_FAILED",
        now: now(),
        runId,
        stageName: stage.name,
        errorMessage: `command executor not configured for stage "${stage.name}"`,
      });
      return;
    }

    const stageRunId = run.stages[stage.name]?.stageRunId;
    if (!stageRunId) {
      await dispatchInline({
        type: "STAGE_FAILED",
        now: now(),
        runId,
        stageName: stage.name,
        errorMessage: `command stage "${stage.name}" has no stageRunId in run state`,
      });
      return;
    }

    const input: CommandStartInput = {
      pipelineName: run.pipelineName,
      runId,
      stageRunId,
      stage,
      loopRound: run.loopRounds,
      isFromFork: meta?.isFromFork ?? false,
    };

    const outcome = await commandExecutor.run(input);
    if (outcome.status === "completed") {
      await dispatchInline({
        type: "STAGE_COMPLETED",
        now: now(),
        runId,
        stageName: stage.name,
        artifacts: outcome.artifacts,
      });
    } else {
      await dispatchInline({
        type: "STAGE_FAILED",
        now: now(),
        runId,
        stageName: stage.name,
        errorMessage: outcome.errorMessage,
      });
    }
  }

  async function runBuiltinStage(
    run: RunState,
    runId: RunId,
    stageRunId: StageRunId,
    stage: Stage,
  ): Promise<void> {
    const isRouter = stage.executor.kind === "builtin/router";
    const executor = isRouter ? builtinRouter : builtinCompose;
    if (!executor) {
      await dispatchInline({
        type: "STAGE_FAILED",
        now: now(),
        runId,
        stageName: stage.name,
        errorMessage: `${stage.executor.kind} executor not configured for stage "${stage.name}"`,
      });
      return;
    }

    const ctx = createBuiltinContext(run, runId, stageRunId, stage.name);
    const outcome = await executor.run({
      runId,
      stageRunId,
      stage,
      loopRound: run.loopRounds,
      ctx,
    });

    if (outcome.status === "completed") {
      await dispatchInline({
        type: "STAGE_COMPLETED",
        now: now(),
        runId,
        stageName: stage.name,
        artifacts: outcome.artifacts,
      });
    } else {
      await dispatchInline({
        type: "STAGE_FAILED",
        now: now(),
        runId,
        stageName: stage.name,
        errorMessage: outcome.errorMessage,
      });
    }
  }

  function createBuiltinContext(
    run: RunState,
    runId: RunId,
    stageRunId: StageRunId,
    stageName: string,
  ): BuiltinTaskContext {
    return {
      runId,
      stageRunId,
      stageName,
      sessionId: run.sessionId,
      pipelineName: run.pipelineName,
      readSiblingArtifacts: async (upstreamStageName: string): Promise<Artifact[]> => {
        const upstream = run.stages[upstreamStageName];
        if (!upstream) return [];
        return store.listArtifacts(runId, upstream.stageRunId);
      },
      sendToSession: async (targetSessionId: string, payload: string): Promise<void> => {
        if (!sendToSession) {
          throw new Error("sendToSession callback not configured on engine deps");
        }
        await sendToSession(targetSessionId, payload);
      },
    };
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

    // Stash projectId/issueId/isFromFork BEFORE dispatch so the START_STAGE
    // effect — which fires synchronously inside the same dispatch — can read
    // them. The persisted RunState shape was locked by v0.1, so we carry
    // these out-of-band.
    runMetadata.set(runId, {
      projectId: input.projectId,
      issueId: input.issueId,
      isFromFork: input.isFromFork ?? false,
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
