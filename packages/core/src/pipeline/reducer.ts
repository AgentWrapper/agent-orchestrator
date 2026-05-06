/**
 * Pure pipeline reducer.
 *
 * Signature: `reduce(state, event) → { state, effects }`. The reducer is
 * synchronous and pure — never reads the clock, never performs I/O. Every
 * event carries `now` so the driver stamps timestamps at enqueue time.
 *
 * Effects are intent-only — the engine (lands in a later sub-task) is
 * responsible for executing them and feeding results back as new events.
 *
 * Event/effect shapes live in events.ts; common helpers live in
 * reducer-helpers.ts.
 */

import { scheduleAfterChange } from "./dag.js";
import type { PipelineEffect, PipelineEvent, ReducerResult } from "./events.js";
import {
  deriveLoopStateFromRun,
  invalidTransition,
  iso,
  materializeArtifact,
  patchRun,
  replaceRun,
  terminateRun,
  terminateRunFromState,
} from "./reducer-helpers.js";
import {
  type ArtifactInput,
  type EngineState,
  type LoopStateName,
  type Pipeline,
  type RunId,
  type RunState,
  type RunTerminationReason,
  type StageRunId,
  type StageState,
  type StageTriggerEvent,
  type Verdict,
  isTerminalLoopState,
  loopKey,
} from "./types.js";

export function reduce(state: EngineState, event: PipelineEvent): ReducerResult {
  switch (event.type) {
    case "TRIGGER_FIRED":
      return reduceTriggerFired(state, event);
    case "STAGE_STARTED":
      return reduceStageStarted(state, event);
    case "STAGE_COMPLETED":
      return reduceStageCompleted(state, event);
    case "STAGE_FAILED":
      return reduceStageFailed(state, event);
    case "NEW_SHA_DETECTED":
      return reduceNewShaDetected(state, event);
    case "RUN_CANCELLED":
      return reduceRunCancelled(state, event);
    case "RUN_RESUMED":
      return reduceRunResumed(state, event);
    case "CONFIG_CHANGED":
      return reduceConfigChanged(state, event);
    case "TICK":
      return { state, effects: [] };
  }
}

interface TriggerFiredEvent {
  now: number;
  trigger: StageTriggerEvent;
  sessionId: string;
  pipeline: Pipeline;
  headSha: string;
  runId: RunId;
  stageRunIds: Record<string, StageRunId>;
}

function reduceTriggerFired(state: EngineState, event: TriggerFiredEvent): ReducerResult {
  const { sessionId, pipeline, headSha, runId, stageRunIds, trigger, now } = event;
  const key = loopKey(sessionId, pipeline.name);

  if (state.currentRunByLoop[key] && state.runs[state.currentRunByLoop[key]]) {
    // Active run already in flight for this loop — driver must cancel via
    // NEW_SHA_DETECTED or RUN_CANCELLED before a new run can start.
    return { state, effects: [] };
  }

  const stages = buildInitialStageStates(pipeline, stageRunIds);
  if (!stages) {
    return invalidTransition(state, "TRIGGER_FIRED missing stageRunIds for one or more stages");
  }

  const priorRound = state.historySummaries[key]?.length ?? 0;
  const isContinuation = trigger === "pr.updated" || trigger === "manual";
  const loopRounds = isContinuation ? priorRound + 1 : Math.max(priorRound, 1);

  const initialRunState: RunState = {
    runId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    sessionId,
    pipelineConfigSnapshot: pipeline,
    headSha,
    loopState: "running",
    loopRounds,
    stages,
    createdAt: iso(now),
    updatedAt: iso(now),
  };

  // Run the DAG scheduler once at trigger time so that:
  //  - stages whose `routes` reference *no upstream* (vacuous predicates) get
  //    a single skip decision instead of sitting pending forever, and
  //  - parallel-startable stages emit START_STAGE in one shot rather than
  //    waiting for the next reducer step.
  const sched = scheduleAfterChange(initialRunState, now);
  const runState = sched.run;

  // Cascade-skipping into a fully-terminal pipeline at trigger time is
  // possible only with degenerate predicates (e.g. `anyFailed: []`). When it
  // happens, terminate the run cleanly instead of leaving an orphaned record.
  if (sched.allTerminal) {
    const stateWithRun: EngineState = {
      ...state,
      runs: { ...state.runs, [runId]: runState },
      currentRunByLoop: { ...state.currentRunByLoop, [key]: runId },
    };
    const preceding: PipelineEffect[] = [
      {
        type: "EMIT_OBSERVATION",
        event: {
          name: "pipeline.run.created",
          data: { runId, pipelineName: pipeline.name, sessionId, trigger, headSha, loopRounds },
        },
      },
      ...skipObservations(runState.runId, sched.newlySkipped, runState),
    ];
    return terminateRunFromState(stateWithRun, runState, "completed", now, "done", preceding);
  }

  const nextState: EngineState = {
    ...state,
    runs: { ...state.runs, [runId]: runState },
    currentRunByLoop: { ...state.currentRunByLoop, [key]: runId },
  };

  const effects: PipelineEffect[] = [
    { type: "PERSIST_RUN", runState },
    {
      type: "PERSIST_LOOP_STATE",
      runId,
      loopState: deriveLoopStateFromRun(runState, now),
    },
    ...sched.startEffects,
    {
      type: "EMIT_OBSERVATION",
      event: {
        name: "pipeline.run.created",
        data: {
          runId,
          pipelineName: pipeline.name,
          sessionId,
          trigger,
          headSha,
          loopRounds,
        },
      },
    },
    ...skipObservations(runState.runId, sched.newlySkipped, runState),
  ];

  return { state: nextState, effects };
}

/**
 * Build "pipeline.stage.terminated" observations for stages that just got
 * skipped via the DAG scheduler. Mirrors the shape emitted by
 * `finalizeStageCompletion` so consumers don't need a per-source schema.
 */
function skipObservations(runId: RunId, skippedNames: string[], run: RunState): PipelineEffect[] {
  return skippedNames.map((stageName) => ({
    type: "EMIT_OBSERVATION" as const,
    event: {
      name: "pipeline.stage.terminated",
      data: {
        runId,
        stageName,
        status: "skipped" as const,
        artifactCount: run.stages[stageName]?.artifacts.length ?? 0,
      },
    },
  }));
}

interface StageStartedEvent {
  now: number;
  runId: RunId;
  stageName: string;
}

function reduceStageStarted(state: EngineState, event: StageStartedEvent): ReducerResult {
  const { runId, stageName, now } = event;
  const run = state.runs[runId];
  if (!run) return invalidTransition(state, `STAGE_STARTED for unknown runId=${runId}`);

  const stage = run.stages[stageName];
  if (!stage) return invalidTransition(state, `STAGE_STARTED for unknown stage=${stageName}`);
  if (stage.status !== "pending") {
    return invalidTransition(
      state,
      `STAGE_STARTED requires pending; got ${stage.status} for ${stageName}`,
    );
  }

  const updatedStage: StageState = { ...stage, status: "running", startedAt: iso(now) };
  const updatedRun = patchRun(run, { [stageName]: updatedStage }, now);

  return {
    state: replaceRun(state, updatedRun),
    effects: [
      { type: "PERSIST_RUN", runState: updatedRun },
      {
        type: "EMIT_OBSERVATION",
        event: {
          name: "pipeline.stage.started",
          // `stageRunId` rotates on every retry/revival, so it's the only
          // field that uniquely identifies *this* execution. `attempt` is
          // not enough now that outdated revival keeps the counter
          // unchanged — two `stage.started` events for the same
          // (runId, stageName) can otherwise share the same attempt.
          data: {
            runId,
            stageName,
            stageRunId: stage.stageRunId,
            attempt: stage.attempt,
          },
        },
      },
    ],
  };
}

interface StageCompletedEvent {
  now: number;
  runId: RunId;
  stageName: string;
  verdict?: Verdict;
  artifacts: ArtifactInput[];
}

function reduceStageCompleted(state: EngineState, event: StageCompletedEvent): ReducerResult {
  const { runId, stageName, verdict, artifacts: artifactInputs, now } = event;
  const run = state.runs[runId];
  if (!run) return invalidTransition(state, `STAGE_COMPLETED for unknown runId=${runId}`);

  const stage = run.stages[stageName];
  if (!stage) return invalidTransition(state, `STAGE_COMPLETED for unknown stage=${stageName}`);
  if (stage.status !== "running") {
    return invalidTransition(
      state,
      `STAGE_COMPLETED requires running; got ${stage.status} for ${stageName}`,
    );
  }

  const newArtifacts = artifactInputs.map((input, idx) =>
    materializeArtifact(input, runId, stage.stageRunId, stageName, idx, now),
  );
  const updatedStage: StageState = {
    ...stage,
    status: "succeeded",
    completedAt: iso(now),
    verdict,
    artifacts: [...stage.artifacts, ...newArtifacts.map((a) => a.artifactId)],
  };

  return finalizeStageCompletion(state, run, stageName, updatedStage, newArtifacts, "success", now);
}

interface StageFailedEvent {
  now: number;
  runId: RunId;
  stageName: string;
  errorMessage: string;
}

function reduceStageFailed(state: EngineState, event: StageFailedEvent): ReducerResult {
  const { runId, stageName, errorMessage, now } = event;
  const run = state.runs[runId];
  if (!run) return invalidTransition(state, `STAGE_FAILED for unknown runId=${runId}`);

  const stage = run.stages[stageName];
  if (!stage) return invalidTransition(state, `STAGE_FAILED for unknown stage=${stageName}`);
  if (stage.status !== "running" && stage.status !== "pending") {
    return invalidTransition(
      state,
      `STAGE_FAILED requires running|pending; got ${stage.status} for ${stageName}`,
    );
  }

  const updatedStage: StageState = {
    ...stage,
    status: "failed",
    completedAt: iso(now),
    errorMessage,
  };

  return finalizeStageCompletion(state, run, stageName, updatedStage, [], "failure", now);
}

interface NewShaEvent {
  now: number;
  sessionId: string;
  pipelineName: string;
  sha: string;
}

function reduceNewShaDetected(state: EngineState, event: NewShaEvent): ReducerResult {
  const { sessionId, pipelineName, sha, now } = event;
  const key = loopKey(sessionId, pipelineName);
  const runId = state.currentRunByLoop[key];
  if (!runId) return { state, effects: [] };

  const run = state.runs[runId];
  if (!run || run.headSha === sha) return { state, effects: [] };

  // Run becomes outdated; loop key is freed so the driver can spawn a new
  // TRIGGER_FIRED for the new SHA.
  return terminateRun(state, run, "outdated", now, "terminated");
}

interface RunCancelledEvent {
  now: number;
  runId: RunId;
  reason: RunTerminationReason;
}

function reduceRunCancelled(state: EngineState, event: RunCancelledEvent): ReducerResult {
  const { runId, reason, now } = event;
  const run = state.runs[runId];
  if (!run) return invalidTransition(state, `RUN_CANCELLED for unknown runId=${runId}`);
  if (run.loopState !== "running" && run.loopState !== "awaiting_context") {
    return invalidTransition(
      state,
      `RUN_CANCELLED requires running|awaiting_context; got ${run.loopState}`,
    );
  }

  const runFinalState: LoopStateName = reason === "stage_failure" ? "stalled" : "terminated";
  return terminateRun(state, run, reason, now, runFinalState);
}

interface RunResumedEvent {
  now: number;
  runId: RunId;
  stageRunIds: Record<string, StageRunId>;
}

/**
 * Resume a stalled/failed run: reset every `failed` stage back to `pending`
 * with a fresh stageRunId (and incremented `attempt`, capped by stage.retries
 * when set), then re-arm the loop pointer so the engine picks the run up on
 * its next tick. No-op when the run has nothing to resume.
 */
function reduceRunResumed(state: EngineState, event: RunResumedEvent): ReducerResult {
  const { runId, stageRunIds, now } = event;
  const run = state.runs[runId];
  if (!run) return invalidTransition(state, `RUN_RESUMED for unknown runId=${runId}`);

  // Resume only applies to runs that have stopped advancing. The CLI rejects
  // non-terminal runs at the service layer; this guard catches direct
  // dispatch (tests, future config-watcher) so the reducer never re-arms a
  // run the engine still considers active.
  if (!isTerminalLoopState(run.loopState)) {
    return invalidTransition(
      state,
      `RUN_RESUMED requires a terminal loop state; got ${run.loopState} for ${runId}`,
    );
  }

  // Refuse to resume when another run already owns the loop key. Without
  // this guard, resuming an old stalled run after a fresh trigger has
  // claimed the loop would silently dispossess the active run of its loop
  // pointer — NEW_SHA_DETECTED, CONFIG_CHANGED, and the triggerRun guard
  // would then track the wrong run.
  const key = loopKey(run.sessionId, run.pipelineName);
  const activeRunId = state.currentRunByLoop[key];
  if (activeRunId !== undefined && activeRunId !== runId) {
    return invalidTransition(
      state,
      `RUN_RESUMED for ${runId} but loop "${key}" is already owned by active run ${activeRunId}; cancel that run before resuming the older one`,
    );
  }

  // `failed` stages are real retries — bump attempt and consume the
  // `stage.retries` budget. `outdated` stages were running when an external
  // event (NEW_SHA_DETECTED, CONFIG_CHANGED, parallel-sibling failure)
  // forced `terminateRunFromState` to cancel them; that's not a stage
  // failure, so reviving them must NOT consume the retry cap. They keep
  // their attempt counter and just get a fresh stageRunId for the next run.
  const failedStageNames = Object.entries(run.stages)
    .filter(([, s]) => s.status === "failed")
    .map(([name]) => name);
  const outdatedStageNames = Object.entries(run.stages)
    .filter(([, s]) => s.status === "outdated")
    .map(([name]) => name);
  if (failedStageNames.length === 0 && outdatedStageNames.length === 0) {
    // Nothing to resume. Keep the state unchanged so the caller can no-op too.
    return { state, effects: [] };
  }

  const stageRetriesByName = new Map<string, number | undefined>();
  for (const stage of run.pipelineConfigSnapshot.stages) {
    stageRetriesByName.set(stage.name, stage.retries);
  }

  const stageDelta: Record<string, StageState> = {};

  // Real retries: bump attempt, check the retries cap.
  for (const name of failedStageNames) {
    const fresh = stageRunIds[name];
    if (!fresh) {
      return invalidTransition(
        state,
        `RUN_RESUMED missing stageRunId for failed stage "${name}"`,
      );
    }
    const prior = run.stages[name];
    const cap = stageRetriesByName.get(name);
    if (cap !== undefined && prior.attempt >= cap + 1) {
      return invalidTransition(
        state,
        `RUN_RESUMED would exceed stage.retries=${cap} for "${name}" (attempt=${prior.attempt})`,
      );
    }
    stageDelta[name] = {
      stageRunId: fresh,
      status: "pending",
      attempt: prior.attempt + 1,
      artifacts: [],
    };
  }

  // External cancellations: don't bump attempt, don't check cap.
  for (const name of outdatedStageNames) {
    const fresh = stageRunIds[name];
    if (!fresh) {
      return invalidTransition(
        state,
        `RUN_RESUMED missing stageRunId for outdated stage "${name}"`,
      );
    }
    const prior = run.stages[name];
    stageDelta[name] = {
      stageRunId: fresh,
      status: "pending",
      attempt: prior.attempt,
      artifacts: [],
    };
  }

  // Also revive any stages that `terminateRunFromState` cascade-skipped when
  // the run failed — they never got an execution attempt, so they keep their
  // existing stageRunId and attempt counter. Without this, a failure in a
  // DAG would permanently lose every downstream branch on resume because
  // `scheduleAfterChange` only considers `pending` stages.
  //
  // `scheduleAfterChange` runs after this delta is applied, so any stage
  // whose `routes` predicate is genuinely unsatisfied gets re-skipped — we
  // don't accidentally revive predicate-driven skips.
  for (const [name, prior] of Object.entries(run.stages)) {
    if (prior.status !== "skipped") continue;
    if (stageDelta[name]) continue;
    stageDelta[name] = {
      stageRunId: prior.stageRunId,
      status: "pending",
      attempt: prior.attempt,
      artifacts: prior.artifacts,
    };
  }

  const updatedRun: RunState = {
    ...run,
    stages: { ...run.stages, ...stageDelta },
    loopState: "running",
    updatedAt: iso(now),
  };
  delete (updatedRun as { terminationReason?: RunTerminationReason }).terminationReason;

  // After re-arming failed/outdated stages, run the DAG scheduler so
  // re-pending stages start in dependsOn order rather than declaration
  // order. Resumes never terminate the run on their own (we just
  // transitioned back to `running`), so we ignore `sched.allTerminal`.
  const sched = scheduleAfterChange(updatedRun, now);
  const finalRun = sched.run;

  const nextState: EngineState = {
    ...state,
    runs: { ...state.runs, [runId]: finalRun },
    currentRunByLoop: { ...state.currentRunByLoop, [key]: runId },
  };

  const effects: PipelineEffect[] = [
    { type: "PERSIST_RUN", runState: finalRun },
    {
      type: "PERSIST_LOOP_STATE",
      runId,
      loopState: deriveLoopStateFromRun(finalRun, now),
    },
    ...sched.startEffects,
    ...skipObservations(runId, sched.newlySkipped, finalRun),
    {
      type: "EMIT_OBSERVATION",
      event: {
        name: "pipeline.run.resumed",
        data: {
          runId,
          pipelineName: run.pipelineName,
          stageNames: [...failedStageNames, ...outdatedStageNames],
        },
      },
    },
  ];

  return { state: nextState, effects };
}

interface ConfigChangedEvent {
  now: number;
  sessionId: string;
  pipelineName: string;
}

function reduceConfigChanged(state: EngineState, event: ConfigChangedEvent): ReducerResult {
  const { sessionId, pipelineName, now } = event;
  const key = loopKey(sessionId, pipelineName);
  const runId = state.currentRunByLoop[key];
  if (!runId) return { state, effects: [] };
  const run = state.runs[runId];
  if (!run) return { state, effects: [] };

  return terminateRun(state, run, "config_change", now, "terminated");
}

function buildInitialStageStates(
  pipeline: Pipeline,
  stageRunIds: Record<string, StageRunId>,
): Record<string, StageState> | null {
  const out: Record<string, StageState> = {};
  for (const stage of pipeline.stages) {
    const stageRunId = stageRunIds[stage.name];
    if (!stageRunId) return null;
    out[stage.name] = {
      stageRunId,
      status: "pending",
      attempt: 1,
      artifacts: [],
    };
  }
  return out;
}

function finalizeStageCompletion(
  state: EngineState,
  run: RunState,
  stageName: string,
  updatedStage: StageState,
  newArtifacts: ReturnType<typeof materializeArtifact>[],
  outcome: "success" | "failure",
  now: number,
): ReducerResult {
  const updatedRun = patchRun(run, { [stageName]: updatedStage }, now);

  const effects: PipelineEffect[] = [];

  if (newArtifacts.length > 0) {
    effects.push({
      type: "APPEND_ARTIFACTS",
      runId: run.runId,
      stageRunId: updatedStage.stageRunId,
      artifacts: newArtifacts,
    });
  }

  effects.push({
    type: "EMIT_OBSERVATION",
    event: {
      name: "pipeline.stage.terminated",
      data: {
        runId: run.runId,
        stageName,
        status: updatedStage.status,
        verdict: updatedStage.verdict,
        artifactCount: updatedStage.artifacts.length,
      },
    },
  });

  // Stage failure terminates the run as `stalled` (existing v0 behavior).
  // Mid-flight or pending stages get cleaned up by terminateRunFromState
  // (running → outdated, pending → skipped) so we don't leak inflight work
  // onto the parallel branches that may still be running.
  if (outcome === "failure") {
    return terminateRunFromState(
      replaceRun(state, updatedRun),
      updatedRun,
      "stage_failure",
      now,
      "stalled",
      effects,
    );
  }

  // Success path: the DAG scheduler may cascade-skip downstream stages whose
  // routes are now unsatisfied, and may immediately schedule the next batch
  // of parallel-eligible stages. Cascade-driven terminality is checked AFTER
  // the cascade — only this can carry the run to `done` in one reducer step.
  const sched = scheduleAfterChange(updatedRun, now);
  effects.push(...skipObservations(run.runId, sched.newlySkipped, sched.run));

  if (sched.allTerminal) {
    return terminateRunFromState(
      replaceRun(state, sched.run),
      sched.run,
      "completed",
      now,
      "done",
      effects,
    );
  }

  effects.unshift({ type: "PERSIST_RUN", runState: sched.run });
  effects.push(...sched.startEffects);

  return { state: replaceRun(state, sched.run), effects };
}
