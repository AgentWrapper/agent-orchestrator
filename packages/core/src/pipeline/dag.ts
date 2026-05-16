/**
 * DAG-aware scheduling for the pipeline reducer.
 *
 * Pure: every function takes timestamps as parameters; no clock reads, no I/O.
 * Split out from reducer-helpers.ts so the reducer can stay focused on
 * event-shape transitions while the dependency / routing logic lives here.
 *
 * Ordering invariants (what callers can rely on):
 *  - Skips cascade in a single pass: skipping a stage may make a downstream
 *    stage's routes evaluate to false, which marks it skipped, which may
 *    cascade further. `scheduleAfterChange` runs the cascade to fixpoint
 *    before emitting any START_STAGE effects.
 *  - Stage declaration order is preserved as priority for slotting: when more
 *    stages are eligible than `maxConcurrentStages` allows, earlier-declared
 *    stages win the available slots. This keeps linear pipelines (no
 *    `dependsOn`) behaviorally identical to v0.
 */

import type { PipelineEffect } from "./events.js";
import {
  collectReferencedStages,
  evaluatePredicate as evalDslPredicate,
  evaluateExitPredicates as evalExit,
  normalizeRoutePredicate,
  type PredicateContext,
} from "./predicate.js";
import { iso, patchRun } from "./reducer-helpers.js";
import {
  type Artifact,
  type RunState,
  type Stage,
  type StageRoutes,
  type StageState,
  isTerminalStageStatus,
} from "./types.js";

export interface ScheduleResult {
  /** Run with any newly-skipped stages applied. May equal the input run. */
  run: RunState;
  /** START_STAGE effects for stages eligible to run, capped by concurrency. */
  startEffects: PipelineEffect[];
  /** Stage names that transitioned `pending → skipped` during this call. */
  newlySkipped: string[];
  /** True iff every stage is in a terminal status. */
  allTerminal: boolean;
}

/**
 * After a state change (TRIGGER_FIRED, STAGE_COMPLETED, RUN_RESUMED), figure
 * out which pending stages should be skipped (routes predicate failed) and
 * which are eligible to start. Cascade skips run to fixpoint before emitting
 * any START_STAGE effects, so downstream stages whose dependencies were just
 * skipped get marked skipped in the same reducer step.
 */
export function scheduleAfterChange(run: RunState, now: number): ScheduleResult {
  const skipResult = applyEligibleSkips(run, now);
  const current = skipResult.run;

  const max = current.pipelineConfigSnapshot.maxConcurrentStages ?? 1;
  const inflight = Object.values(current.stages).filter((s) => s.status === "running").length;
  const slots = Math.max(0, max - inflight);

  const startEffects: PipelineEffect[] = [];
  if (slots > 0) {
    for (const stageDef of current.pipelineConfigSnapshot.stages) {
      if (startEffects.length >= slots) break;
      const state = current.stages[stageDef.name];
      if (state.status !== "pending") continue;
      if (!areDepsSatisfiedForStart(stageDef, current.stages)) continue;
      if (stageDef.routes && !evaluateRoutes(stageDef.routes, current)) continue;
      startEffects.push({
        type: "START_STAGE",
        runId: current.runId,
        stageRunId: state.stageRunId,
        stage: stageDef,
      });
    }
  }

  const allTerminal = Object.values(current.stages).every((s) => isTerminalStageStatus(s.status));
  return { run: current, startEffects, newlySkipped: skipResult.newlySkipped, allTerminal };
}

/**
 * Walk the pipeline and mark as `skipped` every pending stage whose:
 *  - preconditions (`dependsOn` ∪ `routes` refs) are all in a terminal
 *    state — only then is the activation decision deterministic, AND
 *  - `routes` predicate evaluates to `false` (or — when `routes` is unset —
 *    any `dependsOn` reached a non-`succeeded` terminal state).
 *
 * Iterates to fixpoint so cascade skips land in one reducer step.
 *
 * Note: `routes` may reference stages outside `dependsOn` (e.g. a parallel
 * branch the user wants to react to without forcing serialization). The
 * scheduler waits for those references to be terminal too before deciding.
 */
function applyEligibleSkips(run: RunState, now: number): { run: RunState; newlySkipped: string[] } {
  let current = run;
  const newlySkipped: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const stageDef of current.pipelineConfigSnapshot.stages) {
      const state = current.stages[stageDef.name];
      if (state.status !== "pending") continue;
      if (!arePreconditionsTerminal(stageDef, current.stages)) continue;

      const shouldSkip = stageDef.routes
        ? !evaluateRoutes(stageDef.routes, current)
        : !areAllDepsSucceeded(stageDef, current.stages);

      if (shouldSkip) {
        const skippedStage: StageState = {
          ...state,
          status: "skipped",
          completedAt: iso(now),
        };
        current = patchRun(current, { [stageDef.name]: skippedStage }, now);
        newlySkipped.push(stageDef.name);
        changed = true;
      }
    }
  }
  return { run: current, newlySkipped };
}

function arePreconditionsTerminal(stage: Stage, stages: Record<string, StageState>): boolean {
  if (!areDepsTerminal(stage, stages)) return false;
  if (stage.routes) {
    for (const ref of collectReferencedStages(stage.routes.when)) {
      const refState = stages[ref];
      if (!refState || !isTerminalStageStatus(refState.status)) return false;
    }
  }
  return true;
}

function areDepsTerminal(stage: Stage, stages: Record<string, StageState>): boolean {
  const deps = stage.dependsOn ?? [];
  for (const dep of deps) {
    const depState = stages[dep];
    if (!depState || !isTerminalStageStatus(depState.status)) return false;
  }
  return true;
}

function areAllDepsSucceeded(stage: Stage, stages: Record<string, StageState>): boolean {
  const deps = stage.dependsOn ?? [];
  for (const dep of deps) {
    const depState = stages[dep];
    if (!depState || depState.status !== "succeeded") return false;
  }
  return true;
}

/**
 * Eligible-to-start: every `dependsOn` must be `succeeded` (default) so the
 * scheduler doesn't optimistically start a stage whose upstream skipped or
 * failed. Routes are evaluated separately by `evaluateRoutes`.
 */
function areDepsSatisfiedForStart(stage: Stage, stages: Record<string, StageState>): boolean {
  return areAllDepsSucceeded(stage, stages);
}

function evaluateRoutes(routes: StageRoutes, run: RunState): boolean {
  const predicate = normalizeRoutePredicate(routes.when);
  return evalDslPredicate(predicate, predicateContextForRun(run));
}

/**
 * Build the evaluator context off the live run state. Routes only reference
 * stage statuses today, but `Pipeline.exitPredicates` reuses the same context
 * to count open findings; threading `runArtifacts` through both paths keeps
 * a single evaluator implementation rather than two near-duplicates.
 */
export function predicateContextForRun(run: RunState): PredicateContext {
  const artifactsByStage: Record<string, Artifact[]> = run.runArtifacts ?? {};
  return {
    stages: run.stages,
    artifactsByStage,
    allStageNames: run.pipelineConfigSnapshot.stages.map((s) => s.name),
  };
}

export type RunExitOutcome =
  | { kind: "succeeded" }
  | { kind: "failed_exhausted" }
  | { kind: "failed_can_retry" };

/**
 * Evaluate a run's `exitPredicates` once every stage has reached a terminal
 * status. Decision table (all stages terminal, predicates fully evaluated):
 *
 *   exitPredicates true  (or unset)       → `succeeded`
 *   exitPredicates false, rounds exhausted → `failed_exhausted` (loop_failed)
 *   exitPredicates false, rounds remain    → `failed_can_retry` (loop awaits)
 *
 * Rounds are "exhausted" when `Pipeline.maxLoopRounds` is unset (no retry
 * budget configured) OR when `loopRounds >= maxLoopRounds`. The reducer maps
 * these outcomes onto `LoopStateName` — see `reducer.ts`.
 */
export function evaluateRunExitOutcome(run: RunState): RunExitOutcome {
  const pipeline = run.pipelineConfigSnapshot;
  const ctx = predicateContextForRun(run);
  const passed = evalExit(pipeline.exitPredicates, ctx);
  if (passed) return { kind: "succeeded" };
  const maxRounds = pipeline.maxLoopRounds;
  if (maxRounds === undefined || run.loopRounds >= maxRounds) {
    return { kind: "failed_exhausted" };
  }
  return { kind: "failed_can_retry" };
}

/**
 * Find the first cycle in the combined `dependsOn` + `routes.when.stages`
 * graph and return it as `[stage, ..., stage]` (first and last names equal).
 * Trivial self-loops (`[X, X]`) are excluded so the explicit self-reference
 * checks own that error message; multi-node cycles are reported here.
 *
 * Iterative DFS — pure, allocation-bounded. Both edge types contribute
 * because the runtime scheduler waits for either kind of reference before
 * evaluating a stage, so a cycle in either graph deadlocks the run. Used by
 * Zod (`config-schema.ts`) at config load and by the engine
 * (`validatePipelineDag`) as defense-in-depth for programmatic pipelines.
 *
 * The structural input type accepts both Zod-inferred shapes and runtime
 * `Stage` objects so a single implementation serves both call sites.
 */
export function findFirstStageCycle(
  stages: ReadonlyArray<{
    name: string;
    dependsOn?: string[];
    routes?: StageRoutes;
  }>,
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const stage of stages) {
    const routeRefs = stage.routes ? collectReferencedStages(stage.routes.when) : [];
    const edges = new Set<string>([...(stage.dependsOn ?? []), ...routeRefs]);
    adjacency.set(stage.name, [...edges]);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const stage of stages) color.set(stage.name, WHITE);

  for (const stage of stages) {
    if (color.get(stage.name) !== WHITE) continue;
    const stack: Array<{ node: string; iter: number }> = [{ node: stage.name, iter: 0 }];
    const path: string[] = [];
    color.set(stage.name, GRAY);
    path.push(stage.name);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = adjacency.get(top.node) ?? [];
      if (top.iter >= neighbors.length) {
        color.set(top.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const next = neighbors[top.iter];
      top.iter += 1;
      const nextColor = color.get(next);
      if (nextColor === GRAY) {
        const cycleStart = path.indexOf(next);
        // Skip trivial self-loops; explicit self-reference checks emit a
        // clearer error for those.
        if (cycleStart === path.length - 1) continue;
        return [...path.slice(cycleStart), next];
      }
      if (nextColor === WHITE) {
        color.set(next, GRAY);
        path.push(next);
        stack.push({ node: next, iter: 0 });
      }
    }
  }
  return null;
}
