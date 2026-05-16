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
 * Hardcoded predicate forms for v1.1. The typed predicate DSL (and richer
 * `exitPredicates`) lands in v1.3 — this union is intentionally minimal so the
 * scheduler can ship without committing to a DSL surface yet.
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

export interface StageRoutes {
  /** Evaluated once every referenced upstream stage reaches a terminal state. */
  when: StageRoutePredicate;
}

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
}

/**
 * Pipeline-level trigger event. Distinct from `StageTriggerEvent` (the per-stage
 * "when can this stage run within a run" gate) — `PipelineTriggerEvent` controls
 * "when does a *new run* of the whole pipeline get fired".
 */
export type PipelineTriggerEvent = "pr_opened" | "pr_push" | "pr_review_requested" | "manual";

/**
 * One trigger entry under `Pipeline.triggers`. All filter fields are optional;
 * when set they narrow the firing condition. A trigger fires only when its
 * `on` event type matches and every set filter matches.
 *
 * `manual` triggers ignore filters — they only fire from `ao pipeline run`.
 * `manual` is always available regardless of whether it appears in the list.
 */
export interface PipelineTrigger {
  on: PipelineTriggerEvent;
  /** Glob-match against PR base branch. Empty/missing = match any. */
  branches?: string[];
  /** Only fire if the diff touches any of these path globs. Missing = match any. */
  files?: string[];
  /** Only fire if the PR has any of these labels. Missing = match any. */
  labels?: string[];
  /** Skip draft PRs when true. Default false. */
  excludeDrafts?: boolean;
}

/**
 * What happens when a trigger fires while a run is already in progress for
 * the same pipeline.
 *
 *  - `cancel_in_progress` (default) — kill the active run, start fresh.
 *  - `skip` — silently ignore the new trigger.
 *  - `queue` — wait for the active run to terminate, then start.
 */
export type ConcurrencyPolicy = "cancel_in_progress" | "skip" | "queue";

export const DEFAULT_CONCURRENCY_POLICY: ConcurrencyPolicy = "cancel_in_progress";

export interface Pipeline {
  id: PipelineId;
  name: string;
  stages: Stage[];
  /** Default 1 in v0; engine enforces serial execution when unset. */
  maxConcurrentStages?: number;
  /**
   * Auto-firing triggers for this pipeline. Empty or missing = manual only.
   * Unrelated to `Stage.trigger`, which controls intra-run stage gating.
   */
  triggers?: PipelineTrigger[];
  /** Concurrency policy when a trigger fires while a run is active. */
  concurrency?: ConcurrencyPolicy;
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
