/**
 * Pipeline service — pure adapters between the CLI and the v0.1/v0.2 pipeline
 * core (config schema + flat-file store + reducer).
 *
 * Each function takes its dependencies as arguments so the CLI command tests
 * can inject a mocked store / config and assert on store interactions
 * (per the v0.3 acceptance criterion).
 *
 * The service intentionally does NOT depend on the `engine.ts` orchestrator
 * loop: `ao pipeline run` allocates IDs and persists initial run state, but
 * driving stages forward (spawning sessions, polling) is the running
 * orchestrator's job in a later sub-task. This keeps the CLI usable
 * stand-alone for inspection and idempotent for triggers.
 */

import { randomUUID } from "node:crypto";
import {
  asPipelineId,
  asRunId,
  asStageRunId,
  configuredPipelineToRuntime,
  isTerminalLoopState,
  loopKey,
  reduce,
  validatePipelineAgentModes,
  validatePipelineDag,
  type Artifact,
  type ConfiguredPipeline,
  type EngineState,
  type LoopState,
  type OrchestratorConfig,
  type PersistedStageRun,
  type Pipeline,
  type PipelineEffect,
  type PipelineEvent,
  type PipelineStore,
  type PluginRegistry,
  type RunId,
  type RunState,
  type RunSummary,
  type StageRunId,
  type StageState,
} from "@aoagents/ao-core";

/**
 * Thrown by `triggerRun` when a non-terminal run already exists for the same
 * `(sessionId, pipelineName)` loop key. Surfaces the offending runId so the
 * CLI can suggest `ao pipeline cancel <runId>` before retrying.
 */
export class LoopAlreadyActiveError extends Error {
  constructor(
    message: string,
    public readonly activeRunId: RunId,
    public readonly sessionId: string,
    public readonly pipelineName: string,
  ) {
    super(message);
    this.name = "LoopAlreadyActiveError";
  }
}

/** Lightweight summary used by `ao pipeline list`. */
export interface ConfiguredPipelineSummary {
  pipelineId: string;
  name: string;
  stageCount: number;
  triggers: string[];
}

export interface RunFilter {
  pipeline?: string;
  status?: string;
}

export type RunStatusLabel =
  | "running"
  | "awaiting_context"
  | "done"
  | "stalled"
  | "terminated";

/** All pipelines configured for a project (`projects.<id>.pipelines`). */
export function listConfiguredPipelines(
  config: OrchestratorConfig,
  projectId: string,
): ConfiguredPipelineSummary[] {
  const project = config.projects[projectId];
  if (!project?.pipelines) return [];

  return Object.entries(project.pipelines).map(([key, configured]) => {
    const triggers = collectTriggers(configured);
    return {
      pipelineId: asPipelineId(key),
      name: configured.name ?? key,
      stageCount: configured.stages.length,
      triggers,
    };
  });
}

function collectTriggers(configured: ConfiguredPipeline): string[] {
  const seen = new Set<string>();
  for (const stage of configured.stages) {
    for (const event of stage.trigger.on) {
      seen.add(event);
    }
  }
  return [...seen].sort();
}

/**
 * Resolve a pipeline by id (YAML map key) or by `name` field. The map key
 * wins on ties; falls back to a `name`-field match before throwing so
 * `ao pipeline run my-review` works whether the user spelled `pipelines.my-review`
 * or `pipelines.review.name: my-review`.
 */
export function resolveConfiguredPipeline(
  config: OrchestratorConfig,
  projectId: string,
  pipelineName: string,
): Pipeline {
  const project = config.projects[projectId];
  const pipelines = project?.pipelines;
  if (!pipelines) {
    throw new Error(
      `Pipeline "${pipelineName}" is not configured for project "${projectId}".`,
    );
  }

  const direct = pipelines[pipelineName];
  if (direct) return configuredPipelineToRuntime(pipelineName, direct);

  for (const [key, configured] of Object.entries(pipelines)) {
    if (configured.name === pipelineName) {
      return configuredPipelineToRuntime(key, configured);
    }
  }

  throw new Error(
    `Pipeline "${pipelineName}" is not configured for project "${projectId}".`,
  );
}

/** Filtered, newest-first list of runs for `ao pipeline runs`. */
export function listRuns(store: PipelineStore, filter: RunFilter = {}): RunState[] {
  const runs = store.listRuns();
  const filtered = runs.filter((run) => {
    if (
      filter.pipeline &&
      run.pipelineName !== filter.pipeline &&
      run.pipelineId !== filter.pipeline
    )
      return false;
    if (filter.status && run.loopState !== filter.status) return false;
    return true;
  });
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface StageWithArtifacts {
  stageName: string;
  state: StageState;
  artifacts: Artifact[];
}

export interface RunDetail {
  run: RunState;
  loop: LoopState | null;
  stages: StageWithArtifacts[];
}

export function describeRun(store: PipelineStore, runId: RunId): RunDetail {
  const run = store.loadRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const loop = store.loadLoopState(runId);
  const stages: StageWithArtifacts[] = Object.entries(run.stages).map(
    ([stageName, stageState]) => ({
      stageName,
      state: stageState,
      artifacts: store.listArtifacts(runId, stageState.stageRunId),
    }),
  );

  return { run, loop, stages };
}

/** Resolved stage detail used by `ao stage show`. */
export interface StageDetail {
  stage: PersistedStageRun;
  run: RunState | null;
  artifacts: Artifact[];
}

export function describeStage(
  store: PipelineStore,
  stageRunId: StageRunId,
): StageDetail {
  const stage = store.loadStage(stageRunId);
  if (!stage) throw new Error(`Stage not found: ${stageRunId}`);

  const run = store.loadRun(stage.runId);
  const artifacts = store.listArtifacts(stage.runId, stageRunId);
  return { stage, run, artifacts };
}

/** Read-only artifact list used by `ao artifact show <stageRunId>`. */
export function readStageArtifacts(
  store: PipelineStore,
  stageRunId: StageRunId,
): Artifact[] {
  const stage = store.loadStage(stageRunId);
  if (!stage) throw new Error(`Stage not found: ${stageRunId}`);
  return store.listArtifacts(stage.runId, stageRunId);
}

/**
 * Rebuild engine state from the flat-file store. Used so reducer dispatches
 * see existing runs / loop pointers / history rather than starting from
 * `emptyEngineState()` (which would defeat the reducer's collision guards).
 *
 * Terminal runs go into `historySummaries`; the latest non-terminal run on
 * each loop key wins `currentRunByLoop`.
 */
export function hydrateEngineState(store: PipelineStore): EngineState {
  const runs: Record<string, RunState> = {};
  const currentRunByLoop: Record<string, RunId> = {};
  const historySummaries: Record<string, RunSummary[]> = {};

  // Sort oldest-first so historySummaries preserves chronological order.
  const sorted = [...store.listRuns()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  for (const run of sorted) {
    runs[run.runId] = run;
    const key = loopKey(run.sessionId, run.pipelineName);

    if (isTerminalLoopState(run.loopState)) {
      const list = historySummaries[key] ?? [];
      list.push({
        runId: run.runId,
        loopState: run.loopState,
        ...(run.terminationReason ? { terminationReason: run.terminationReason } : {}),
        headSha: run.headSha,
        loopRounds: run.loopRounds,
        fingerprints: [],
        createdAt: run.createdAt,
      });
      historySummaries[key] = list;
    } else {
      currentRunByLoop[key] = run.runId;
    }
  }

  return { runs, currentRunByLoop, historySummaries };
}

/** Sentinel recorded in RunState.headSha when a run is triggered via CLI with no git context. */
const MANUAL_TRIGGER_SHA = "manual";

export interface TriggerOptions {
  sessionId?: string;
  headSha?: string;
}

/**
 * Trigger a manual run for a pipeline. Hydrates engine state from the store
 * so the reducer's "active run already in flight for this loop" guard fires
 * when a non-terminal run already exists. Returns the allocated run id; the
 * running orchestrator drives stage execution.
 *
 * `sessionId` defaults to `pipeline.<name>` so a CLI-triggered run can be
 * looked up by name without a worker session attached. Callers that already
 * have a session (e.g. lifecycle integration in v0.4) should override it.
 */
export function triggerRun(
  store: PipelineStore,
  registry: PluginRegistry,
  pipeline: Pipeline,
  options: TriggerOptions = {},
  now: () => number = Date.now,
): RunId {
  validatePipelineAgentModes(pipeline, registry);
  validatePipelineDag(pipeline);

  const sessionId = options.sessionId ?? `pipeline.${pipeline.name}`;
  const initialState = hydrateEngineState(store);
  const key = loopKey(sessionId, pipeline.name);
  const activeRunId = initialState.currentRunByLoop[key];
  if (activeRunId && initialState.runs[activeRunId]) {
    throw new LoopAlreadyActiveError(
      `Pipeline "${pipeline.name}" already has an active run (${activeRunId}). ` +
        `Cancel it with \`ao pipeline cancel ${activeRunId}\` before triggering a new one.`,
      activeRunId,
      sessionId,
      pipeline.name,
    );
  }

  const runId = asRunId(`run-${randomUUID()}`);
  const stageRunIds: Record<string, StageRunId> = {};
  for (const stage of pipeline.stages) {
    stageRunIds[stage.name] = asStageRunId(`sr-${randomUUID()}`);
  }

  applyEvent(store, initialState, {
    type: "TRIGGER_FIRED",
    now: now(),
    trigger: "manual",
    sessionId,
    pipeline,
    headSha: options.headSha ?? MANUAL_TRIGGER_SHA,
    runId,
    stageRunIds,
  });

  return runId;
}

/**
 * Cancel an in-flight run. Hydrates engine state from the store, dispatches
 * RUN_CANCELLED through the reducer, and persists effects.
 *
 * Returns `{ run, alreadyTerminal }`. `alreadyTerminal` is true when the run
 * was already in a terminal loop state and the reducer was not invoked, so
 * the caller can distinguish a no-op from an actual cancellation. Stalled
 * runs are reported as already terminal — the user should `resume` instead,
 * or accept the existing terminal state.
 */
export interface CancelResult {
  run: RunState;
  alreadyTerminal: boolean;
}

export function cancelRun(
  store: PipelineStore,
  runId: RunId,
  now: () => number = Date.now,
): CancelResult {
  const run = store.loadRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  if (isTerminalLoopState(run.loopState)) {
    return { run, alreadyTerminal: true };
  }

  applyEvent(store, hydrateEngineState(store), {
    type: "RUN_CANCELLED",
    now: now(),
    runId,
    reason: "manual_cancel",
  });

  const updated = store.loadRun(runId) ?? run;
  return { run: updated, alreadyTerminal: false };
}

/**
 * Re-attempt failed stages of a previously terminated run by dispatching
 * RUN_RESUMED through the reducer. The reducer enforces the `stage.retries`
 * cap and emits the same persistence + start-stage effects as the initial
 * trigger, so a CLI resume looks indistinguishable from a fresh trigger to
 * downstream consumers.
 *
 * Returns the run with the list of stage names that were reset (empty when
 * the run had nothing to resume — that's a no-op, not an error).
 */
export interface ResumeResult {
  run: RunState;
  resetStages: string[];
}

export function resumeRun(
  store: PipelineStore,
  runId: RunId,
  now: () => number = Date.now,
): ResumeResult {
  const run = store.loadRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  // Resume is only meaningful for runs that have stopped advancing — i.e.
  // already in a terminal loop state. Bailing out on `running` /
  // `awaiting_context` prevents a concurrent CLI resume from re-arming a
  // run that the engine still considers in flight (which once v0.4 wires
  // the orchestrator to the store could double-spawn stages).
  if (!isTerminalLoopState(run.loopState)) {
    throw new Error(
      `Run ${runId} is in state "${run.loopState}", not a terminal state. ` +
        `Cancel it first with \`ao pipeline cancel ${runId}\` if you want to restart.`,
    );
  }

  // Both `failed` and `outdated` stages need a fresh stageRunId on resume.
  // `failed` is a real retry; `outdated` is the running-at-terminate state
  // (e.g. parallel sibling cancelled by `terminateRunFromState`) whose work
  // was thrown away. Without including outdated, parallel branches lost
  // when a sibling fails would never be recoverable via resume.
  const retriedStageNames = Object.entries(run.stages)
    .filter(([, s]) => s.status === "failed" || s.status === "outdated")
    .map(([name]) => name);
  if (retriedStageNames.length === 0) {
    return { run, resetStages: [] };
  }

  const stageRunIds: Record<string, StageRunId> = {};
  for (const name of retriedStageNames) {
    stageRunIds[name] = asStageRunId(`sr-${randomUUID()}`);
  }

  applyEvent(store, hydrateEngineState(store), {
    type: "RUN_RESUMED",
    now: now(),
    runId,
    stageRunIds,
  });

  const updated = store.loadRun(runId);
  return { run: updated ?? run, resetStages: retriedStageNames };
}

/**
 * Pipeline store-schema migration helper. v0.3 ships no schema changes yet —
 * the helper exists so the verb is wired and stable; future schema bumps
 * (the v0.4+ run-versioning epic) plug in here without churning the CLI.
 */
export interface MigrateResult {
  migrated: number;
  message: string;
}

export function migrateStore(_store: PipelineStore): MigrateResult {
  return {
    migrated: 0,
    message: "Pipeline store is already on the v0.3 schema — nothing to migrate.",
  };
}

/**
 * Drive a single reducer step against `initialState` and persist all effects.
 * Intentionally sequential and synchronous: the CLI is one-shot and never
 * spawns stage sessions itself.
 */
function applyEvent(
  store: PipelineStore,
  initialState: EngineState,
  event: PipelineEvent,
): void {
  const result = reduce(initialState, event);
  for (const effect of result.effects) {
    persistEffect(store, effect);
  }
}

function persistEffect(store: PipelineStore, effect: PipelineEffect): void {
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
    case "START_STAGE":
    case "CANCEL_STAGE":
    case "EMIT_OBSERVATION":
      // Side effects owned by the engine driver; CLI is store-only.
      break;
  }
}
