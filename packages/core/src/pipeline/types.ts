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

/**
 * Routes findings from upstream stages into an existing AO session via
 * {@link BuiltinTaskContext.sendToSession}. Replaces the original spec's
 * `SEND_TO_AGENT` reducer command — the routing decision is now a stage with
 * its own state, retries, and DAG position.
 */
export interface BuiltinRouterExecutor {
  kind: "builtin/router";
  /**
   * The upstream stage names whose findings should be delivered. Must be a
   * subset of this stage's `dependsOn` so the scheduler has already
   * finalized them when the router runs.
   */
  fromStages: string[];
  /**
   * Target session resolution. Either a literal sessionId or a sentinel
   * keyword the engine resolves at run time. v1.2 only supports `"self"`
   * (the session this pipeline run is scoped to) — additional resolvers
   * land alongside cross-session orchestration.
   */
  target: { kind: "session"; sessionId: string } | { kind: "self" };
}

/**
 * Bundles findings from multiple upstream stages into a single composite
 * findings artifact for a downstream stage to consume. The composite is
 * emitted as a `json` artifact whose `data.findings` is the merged list,
 * tagged with the originating stage name.
 */
export interface BuiltinComposeExecutor {
  kind: "builtin/compose";
  /**
   * The upstream stage names whose findings should be merged. Must be a
   * subset of this stage's `dependsOn`.
   */
  fromStages: string[];
}

export type BuiltinExecutor = BuiltinRouterExecutor | BuiltinComposeExecutor;

export type StageExecutor = AgentExecutor | CommandExecutor | BuiltinExecutor;

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
  /**
   * Opt-in fork-PR safety override for `command` stages. The command executor
   * refuses to run a stage whose triggering PR is from a fork unless this is
   * set to `true`. Agent and builtin stages ignore the flag — agent stages
   * run in their own sandboxed sessions, and builtins are pure functions over
   * findings. Default `false` (refuse on forks).
   */
  allowFork?: boolean;
}

export interface Pipeline {
  id: PipelineId;
  name: string;
  stages: Stage[];
  /** Default 1 in v0; engine enforces serial execution when unset. */
  maxConcurrentStages?: number;
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

// ============================================================================
// Builtin task context
// ============================================================================

/**
 * Capabilities surface a `builtin/*` executor sees at run time. The engine
 * constructs a fresh context per stage invocation — the implementation is the
 * only place that touches the pipeline store and session manager, so builtin
 * executors stay testable as pure functions over their context.
 *
 * v1.2 exposes the two capabilities the spec calls out:
 *   - read findings from sibling stages (router + compose)
 *   - send a payload to a target session (router)
 *
 * Artifacts are NOT written through this context. Builtins return their
 * artifacts in `BuiltinOutcome.artifacts` and the engine persists them via
 * its normal `STAGE_COMPLETED → APPEND_ARTIFACTS` path, which keeps a single
 * write path (the reducer) authoritative for the pipeline store.
 *
 * The context is intentionally narrow: builtins must not need access to the
 * full SessionManager or PipelineStore. If a builtin needs a capability not
 * exposed here, extend this interface rather than passing the underlying
 * dependency through.
 */
export interface BuiltinTaskContext {
  /** Identity of the stage currently executing. */
  runId: RunId;
  stageRunId: StageRunId;
  stageName: string;
  /** Pipeline run scope, for routing and downstream lookups. */
  sessionId: string;
  pipelineName: string;
  /**
   * Return artifacts emitted by an upstream sibling stage in the same run.
   *
   * Returns `[]` in three distinct cases:
   *   - Unknown stage name (typo or wrong `fromStages` config) — silent empty.
   *   - Stage exists but has not completed yet — silent empty. The Zod config
   *     schema enforces `fromStages ⊆ dependsOn`, so at runtime the scheduler
   *     guarantees all listed stages are already terminal before this runs.
   *   - Stage completed with zero artifacts — expected empty.
   */
  readSiblingArtifacts(stageName: string): Promise<Artifact[]>;
  /**
   * Deliver a payload to a target session. Implementations route through
   * `SessionManager.send()`. The payload is the literal message body the
   * target session receives.
   */
  sendToSession(targetSessionId: string, payload: string): Promise<void>;
}
