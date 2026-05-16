/**
 * Pipeline core types — branded IDs, configuration shapes, runtime state,
 * artifacts, and the three-tier exit model (stage / run / loop).
 *
 * v0.1 scope: pure data shapes only. No I/O, no executors. Consumed by the
 * reducer (pipeline/reducer.ts) and the flat-file store (pipeline/store.ts).
 *
 * Design decisions locked from cluster planning (see issue #1627):
 *  - No Agent.executeTask plugin contract; stages run via existing session machinery.
 *  - Findings via convention: stages drop {workspacePath}/.ao/pipeline-findings.jsonl.
 *  - supportedTaskModes is a manifest field on agent plugins, not an interface method.
 *  - maxLoopRounds is per-stage, not pipeline-global.
 *  - maxConcurrentStages defaults to 1 in v0.
 *  - command executor stages are NOT talk-to-able.
 */

// ============================================================================
// Branded IDs
// ============================================================================

export type PipelineId = string & { readonly __brand: "PipelineId" };
export type RunId = string & { readonly __brand: "RunId" };
export type StageRunId = string & { readonly __brand: "StageRunId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export const asPipelineId = (id: string): PipelineId => id as PipelineId;
export const asRunId = (id: string): RunId => id as RunId;
export const asStageRunId = (id: string): StageRunId => id as StageRunId;
export const asArtifactId = (id: string): ArtifactId => id as ArtifactId;

// ============================================================================
// Pipeline configuration
// ============================================================================

/** Modes an agent plugin advertises in its manifest's `supportedTaskModes` field. */
export type TaskMode = "review" | "code" | "answer";

export type StageTriggerEvent =
  | "pr.opened"
  | "pr.updated"
  | "pr.merge_ready"
  | "pr.merged"
  | "manual";

export interface StageTrigger {
  on: StageTriggerEvent[];
}

export interface AgentExecutor {
  kind: "agent";
  /** Plugin name from the agent slot registry (e.g. "claude-code", "codex"). */
  plugin: string;
  /** Must appear in the plugin manifest's `supportedTaskModes`. */
  mode: TaskMode;
  config?: Record<string, unknown>;
}

export interface CommandExecutor {
  kind: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory relative to the stage workspace. */
  cwd?: string;
}

export type StageExecutor = AgentExecutor | CommandExecutor;

export interface TaskSpec {
  /** Prompt text injected into the spawned agent session, or main script body for command. */
  prompt?: string;
  /** Optional schema describing the expected JSON outputs of the stage. */
  outputSchema?: Record<string, unknown>;
  /** Free-form named inputs available to the stage. */
  inputs?: Record<string, unknown>;
}

export interface StagePolicy {
  blocksMerge?: boolean;
  /** Convergence window: number of recent runs whose findings must be unchanged. */
  stallWindow?: number;
}

export interface StageBudget {
  maxUsd?: number;
  maxDurationMs?: number;
}

/**
 * Hardcoded route predicates from v1.1. v1.3 introduces the typed `Predicate`
 * DSL ({@link Predicate}); routes accept either shape so existing pipelines
 * keep working without a rewrite. Internally `dag.ts` normalizes both into the
 * same evaluator.
 *
 * All forms reference stage names within the same pipeline. Validation at
 * config load rejects unknown names; the scheduler trusts the input here.
 *
 * **Known limitation in v1.1: `anyFailed` is reachable only via cascade-skip,
 * not for "run-on-failure" recovery branches.** The reducer terminates the
 * run as `stalled` immediately on any STAGE_FAILED, so a downstream stage
 * with `routes.when.kind === "anyFailed"` whose predicate would evaluate
 * `true` never gets a chance to run — `terminateRunFromState` marks it
 * `skipped` first. Operators can still use `anyFailed` to express "skip
 * this stage if any upstream failed" semantics in conjunction with other
 * predicates, but rollback/cleanup-on-failure stages aren't supported until
 * failure-tolerant scheduling lands in v1.2/v1.3.
 */
export type StageRoutePredicate =
  | { kind: "allSucceeded"; stages: string[] }
  | { kind: "anySucceeded"; stages: string[] }
  | { kind: "anyFailed"; stages: string[] };

/**
 * v1.3 typed predicate DSL used by `Stage.routes.when` (new form) and
 * `Pipeline.exitPredicates`. JSON-schema validated at config load.
 *
 * Leaf semantics:
 *  - `all_pass`             — every referenced stage's terminal status is `succeeded`
 *                             (or, when verdict is set, verdict === "pass").
 *  - `no_open_findings`     — no finding artifacts in scope have `status === "open"`.
 *  - `finding_count_below`  — fewer than `n` open findings exist in scope.
 *
 * The optional `stages` field scopes the leaf to a subset of stages. When
 * omitted, the leaf evaluates over every stage in the run (the natural default
 * for `Pipeline.exitPredicates`). Routes always set `stages` since they're
 * gating an individual stage on prior siblings.
 */
export type Predicate =
  | { kind: "all_pass"; stages?: string[] }
  | { kind: "any_failed"; stages?: string[] }
  | { kind: "no_open_findings"; stages?: string[] }
  | { kind: "finding_count_below"; n: number; stages?: string[] }
  | { kind: "and"; predicates: Predicate[] }
  | { kind: "or"; predicates: Predicate[] }
  | { kind: "not"; predicate: Predicate };

export interface StageRoutes {
  /** Evaluated once every referenced upstream stage reaches a terminal state. */
  when: StageRoutePredicate | Predicate;
}

/**
 * Workspace isolation class — see issue #1632.
 *
 *  - `independent`   (default): fresh session + fresh worktree; the stage sees
 *                               nothing from prior sibling stages.
 *  - `read-siblings`         : fresh session + fresh worktree, but the stage's
 *                               prompt is augmented with read-only access to
 *                               artifacts produced by upstream stages. Useful for
 *                               "fix" stages that consume "review" findings.
 *
 * The original v0.1 spec had `shared-ro` / `isolated-rw` classes designed for a
 * model where stages shared a workspace. Fresh-session-per-stage made that
 * obsolete; the surviving distinction is just whether sibling artifacts are
 * surfaced to the agent.
 *
 * Enforced by WorkspaceGuard at config load — see {@link ConfiguredPipelineSchema}.
 */
export type WorkspaceClass = "independent" | "read-siblings";

export interface Stage {
  name: string;
  trigger: StageTrigger;
  executor: StageExecutor;
  task: TaskSpec;
  policy?: StagePolicy;
  budget?: StageBudget;
  /** ISO 8601 duration string or millisecond count. Engine treats as advisory. */
  timeoutMs?: number;
  retries?: number;
  /** Per-stage loop cap (locked decision: not pipeline-global). */
  maxLoopRounds?: number;
  /**
   * Stage names this stage waits for before it can be evaluated. Default `[]`.
   * The named stages must reach a terminal status before the scheduler
   * considers this stage. Unknown names and cycles are rejected at config load.
   */
  dependsOn?: string[];
  /**
   * Conditional activation predicate. When set and the predicate evaluates to
   * `false` (after every referenced upstream stage is terminal), this stage is
   * marked `skipped` instead of being started. When unset, the default is
   * "all `dependsOn` stages must have succeeded".
   */
  routes?: StageRoutes;
  /**
   * v1.3 — workspace isolation class. Defaults to `independent`.
   * `read-siblings` requires at least one upstream stage (`dependsOn` or any
   * preceding stage); WorkspaceGuard rejects orphans at config load.
   */
  workspaceClass?: WorkspaceClass;
}

export interface Pipeline {
  id: PipelineId;
  name: string;
  stages: Stage[];
  /** Default 1 in v0; engine enforces serial execution when unset. */
  maxConcurrentStages?: number;
  /**
   * v1.3 — run-completion conditions. Evaluated when every stage in the run
   * reaches a terminal status. When unset, defaults to the v1.1 behavior
   * (success ⇔ allTerminal regardless of artifacts).
   *
   * Multiple predicates are AND-combined. The result selects the terminal
   * loop state:
   *   - true  → loop state `done`     (loop_succeeded)
   *   - false → loop state `stalled`  (loop_failed) once `maxLoopRounds` is
   *             reached; otherwise the run terminates as `awaiting_context`
   *             so the next trigger can attempt another round.
   */
  exitPredicates?: Predicate[];
  /**
   * v1.3 — pipeline-level loop cap. When set, `loopRounds >= maxLoopRounds`
   * combined with falsy `exitPredicates` produces the `loop_failed` terminal.
   * Per-stage `maxLoopRounds` is unrelated — that one caps retries within a
   * single run; this caps re-trigger rounds across runs.
   */
  maxLoopRounds?: number;
}

// ============================================================================
// Artifacts
// ============================================================================

export type Severity = "error" | "warning" | "info";

export type ArtifactStatus = "open" | "dismissed" | "sent_to_agent" | "resolved";

export interface FindingArtifactInput {
  kind: "finding";
  filePath: string;
  startLine: number;
  endLine: number;
  title: string;
  description: string;
  /** "security" | "correctness" | "style" | ... | "general". */
  category: string;
  severity: Severity;
  /** 0.0–1.0. */
  confidence: number;
  /** Structural anchor (function/class name) for fingerprint stability. */
  anchorSignature?: string;
}

export interface JsonArtifactInput {
  kind: "json";
  data: Record<string, unknown>;
}

export type ArtifactInput = FindingArtifactInput | JsonArtifactInput;

export type Artifact = ArtifactInput & {
  artifactId: ArtifactId;
  pipelineRunId: RunId;
  stageRunId: StageRunId;
  stageName: string;
  fingerprint?: string;
  status: ArtifactStatus;
  createdAt: string;
  sentToAgentAt?: string;
  /** Reducer-set when finding.confidence < pipeline/stage threshold. */
  belowConfidenceThreshold?: boolean;
};

/** Filename stages drop in {workspacePath}/.ao/ for findings discovery. */
export const PIPELINE_FINDINGS_FILENAME = "pipeline-findings.jsonl";

// ============================================================================
// Three-tier exit model
// ============================================================================
//
// Tier 1 — Stage exit: a single stage execution finishes (StageStatus terminal).
// Tier 2 — Run exit:   a pipeline run terminates (RunTerminationReason).
// Tier 3 — Loop exit:  the persistent per-session loop terminates (LoopState terminal).
//
// Each tier composes upward: a stage exit may cause a run exit, which may cause a
// loop exit. The reducer is the single point that performs these escalations.

export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "outdated";

export const TERMINAL_STAGE_STATUSES: readonly StageStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "outdated",
] as const;

export type Verdict = "pass" | "fail" | "neutral";

export type RunTerminationReason =
  | "completed"
  | "stage_failure"
  | "manual_cancel"
  | "config_change"
  | "outdated"
  | "worker_dead";

export type LoopStateName = "running" | "awaiting_context" | "done" | "stalled" | "terminated";

export const TERMINAL_LOOP_STATES: readonly LoopStateName[] = [
  "done",
  "stalled",
  "terminated",
] as const;

export function isTerminalStageStatus(s: StageStatus): boolean {
  return TERMINAL_STAGE_STATUSES.includes(s);
}

export function isTerminalLoopState(s: LoopStateName): boolean {
  return TERMINAL_LOOP_STATES.includes(s);
}

// ============================================================================
// Runtime state
// ============================================================================

export interface StageState {
  stageRunId: StageRunId;
  status: StageStatus;
  attempt: number;
  verdict?: Verdict;
  artifacts: ArtifactId[];
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface RunState {
  runId: RunId;
  pipelineId: PipelineId;
  pipelineName: string;
  sessionId: string;
  /** Frozen at run-create — config changes during a run terminate the run. */
  pipelineConfigSnapshot: Pipeline;
  headSha: string;
  loopState: LoopStateName;
  terminationReason?: RunTerminationReason;
  loopRounds: number;
  /** Keyed by stage name. v0 has at most one entry per stage. */
  stages: Record<string, StageState>;
  /**
   * v1.3 — artifacts materialized by the reducer during this run, keyed by
   * stage name (declaration order preserved by Object semantics is irrelevant
   * — predicates iterate explicitly). Required for `exitPredicates` to
   * count/filter findings without round-tripping through the store. Optional
   * so v1.1 RunStates loaded from disk still parse.
   */
  runArtifacts?: Record<string, Artifact[]>;
  createdAt: string;
  updatedAt: string;
}

export interface LoopState {
  sessionId: string;
  pipelineName: string;
  loopState: LoopStateName;
  loopRounds: number;
  lastSha: string;
  currentRunId?: RunId;
  updatedAt: string;
}

/** Compact run record used for stalled-detection across runs. */
export interface RunSummary {
  runId: RunId;
  loopState: LoopStateName;
  terminationReason?: RunTerminationReason;
  headSha: string;
  loopRounds: number;
  /** Sorted list of artifact fingerprints from the run, used by convergence. */
  fingerprints: string[];
  createdAt: string;
}

/**
 * Engine-global state. Multiple in-flight runs may exist (e.g. an old run is
 * being torn down while a new SHA spawns its replacement), so we key by RunId.
 *
 * Two-level state: this top-level structure holds engine-global counters /
 * indices; per-run details live in the keyed RunState entries.
 */
export interface EngineState {
  runs: Record<RunId, RunState>;
  /** Loop key ("{sessionId}:{pipelineName}") → currently-active runId. */
  currentRunByLoop: Record<string, RunId>;
  /** Loop key → ordered history (oldest first), used by convergence detection. */
  historySummaries: Record<string, RunSummary[]>;
}

export function loopKey(sessionId: string, pipelineName: string): string {
  return `${sessionId}:${pipelineName}`;
}

export function emptyEngineState(): EngineState {
  return {
    runs: {},
    currentRunByLoop: {},
    historySummaries: {},
  };
}
