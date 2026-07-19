package pipeline

import "time"

// ============================================================================
// Enums
// ============================================================================

// StageTriggerEvent names an event a stage's trigger reacts to.
//
// v1 scope is worker-only ("pr.*" and "manual"). The old TypeScript source
// also defined "orchestrator.*" and "workstream.*" trigger families for
// pipeline-v3 scopes; those are phase 2 and intentionally not defined here.
// Validation is table-driven off AllStageTriggerEvents, so adding the phase 2
// values later is a one-line change to that table, not a schema rewrite.
type StageTriggerEvent string

// Known v1 stage trigger events.
const (
	TriggerPROpened     StageTriggerEvent = "pr.opened"
	TriggerPRUpdated    StageTriggerEvent = "pr.updated"
	TriggerPRMergeReady StageTriggerEvent = "pr.merge_ready"
	TriggerPRMerged     StageTriggerEvent = "pr.merged"
	TriggerManual       StageTriggerEvent = "manual"
)

// AllStageTriggerEvents lists every trigger event known in v1.
var AllStageTriggerEvents = []StageTriggerEvent{
	TriggerPROpened, TriggerPRUpdated, TriggerPRMergeReady, TriggerPRMerged, TriggerManual,
}

// IsKnown reports whether e is one of the v1 stage trigger events.
func (e StageTriggerEvent) IsKnown() bool {
	for _, k := range AllStageTriggerEvents {
		if e == k {
			return true
		}
	}
	return false
}

// Scope mirrors the pipeline-v3 spec's three scopes. v1 config
// validation accepts only the empty string (which defaults to
// ScopeWorker) or ScopeWorker itself; ScopeOrchestrator and ScopeWorkstream
// are declared here so the type is future-proof but are rejected at
// validation time with a "deferred to phase 2" message.
type Scope string

// Known pipeline scopes. Only ScopeWorker is accepted by v1 validation.
const (
	ScopeWorker       Scope = "worker"
	ScopeOrchestrator Scope = "orchestrator"
	ScopeWorkstream   Scope = "workstream"
)

// AllScopes lists every scope defined by the spec, including the
// phase 2 scopes that v1 validation rejects.
var AllScopes = []Scope{ScopeWorker, ScopeOrchestrator, ScopeWorkstream}

// IsKnown reports whether s is one of the scopes defined by the spec
// (regardless of whether v1 validation currently accepts it).
func (s Scope) IsKnown() bool {
	for _, k := range AllScopes {
		if s == k {
			return true
		}
	}
	return false
}

// TaskMode is a mode an agent plugin advertises support for and a stage's
// agent executor requests.
type TaskMode string

// Known task modes.
const (
	ModeReview TaskMode = "review"
	ModeCode   TaskMode = "code"
	ModeAnswer TaskMode = "answer"
)

// AllTaskModes lists every known task mode.
var AllTaskModes = []TaskMode{ModeReview, ModeCode, ModeAnswer}

// IsKnown reports whether m is a known task mode.
func (m TaskMode) IsKnown() bool {
	for _, k := range AllTaskModes {
		if m == k {
			return true
		}
	}
	return false
}

// ExecutorKind names how a stage runs: an agent session, a shelled-out
// command, or an engine-internal builtin.
type ExecutorKind string

// Known executor kinds.
const (
	ExecutorAgent   ExecutorKind = "agent"
	ExecutorCommand ExecutorKind = "command"
	ExecutorBuiltin ExecutorKind = "builtin"
)

// AllExecutorKinds lists every known executor kind.
var AllExecutorKinds = []ExecutorKind{ExecutorAgent, ExecutorCommand, ExecutorBuiltin}

// IsKnown reports whether k is a known executor kind.
func (k ExecutorKind) IsKnown() bool {
	for _, known := range AllExecutorKinds {
		if k == known {
			return true
		}
	}
	return false
}

// BuiltinName names an engine-internal builtin executor. Builtins run inside
// the engine process; they never spawn a session or shell out.
type BuiltinName string

// Known builtin executors.
const (
	BuiltinRouter  BuiltinName = "router"
	BuiltinCompose BuiltinName = "compose"
)

// AllBuiltinNames lists every known builtin executor name.
var AllBuiltinNames = []BuiltinName{BuiltinRouter, BuiltinCompose}

// IsKnown reports whether n is a known builtin executor name.
func (n BuiltinName) IsKnown() bool {
	for _, k := range AllBuiltinNames {
		if n == k {
			return true
		}
	}
	return false
}

// Severity classifies a finding artifact's importance.
type Severity string

// Known severities.
const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// AllSeverities lists every known severity.
var AllSeverities = []Severity{SeverityError, SeverityWarning, SeverityInfo}

// IsKnown reports whether s is a known severity.
func (s Severity) IsKnown() bool {
	for _, k := range AllSeverities {
		if s == k {
			return true
		}
	}
	return false
}

// Verdict is a stage's pass/fail/neutral judgement, distinct from its
// lifecycle StageStatus.
type Verdict string

// Known verdicts.
const (
	VerdictPass    Verdict = "pass"
	VerdictFail    Verdict = "fail"
	VerdictNeutral Verdict = "neutral"
)

// AllVerdicts lists every known verdict.
var AllVerdicts = []Verdict{VerdictPass, VerdictFail, VerdictNeutral}

// IsKnown reports whether v is a known verdict.
func (v Verdict) IsKnown() bool {
	for _, k := range AllVerdicts {
		if v == k {
			return true
		}
	}
	return false
}

// StageStatus is a stage run's lifecycle status.
type StageStatus string

// Known stage statuses.
const (
	StageStatusPending   StageStatus = "pending"
	StageStatusRunning   StageStatus = "running"
	StageStatusSucceeded StageStatus = "succeeded"
	StageStatusFailed    StageStatus = "failed"
	StageStatusSkipped   StageStatus = "skipped"
	StageStatusOutdated  StageStatus = "outdated"
)

// AllStageStatuses lists every known stage status.
var AllStageStatuses = []StageStatus{
	StageStatusPending, StageStatusRunning, StageStatusSucceeded,
	StageStatusFailed, StageStatusSkipped, StageStatusOutdated,
}

// IsKnown reports whether s is a known stage status.
func (s StageStatus) IsKnown() bool {
	for _, k := range AllStageStatuses {
		if s == k {
			return true
		}
	}
	return false
}

// IsTerminal reports whether s is a terminal stage status: succeeded,
// failed, skipped, or outdated.
func (s StageStatus) IsTerminal() bool {
	switch s {
	case StageStatusSucceeded, StageStatusFailed, StageStatusSkipped, StageStatusOutdated:
		return true
	default:
		return false
	}
}

// LoopStateName is the persistent per-session pipeline loop's lifecycle
// state (tier 3 of the three-tier exit model: stage exit -> run exit ->
// loop exit).
type LoopStateName string

// Known loop states.
const (
	LoopRunning         LoopStateName = "running"
	LoopAwaitingContext LoopStateName = "awaiting_context"
	LoopDone            LoopStateName = "done"
	LoopStalled         LoopStateName = "stalled"
	LoopTerminated      LoopStateName = "terminated"
)

// AllLoopStateNames lists every known loop state.
var AllLoopStateNames = []LoopStateName{
	LoopRunning, LoopAwaitingContext, LoopDone, LoopStalled, LoopTerminated,
}

// IsKnown reports whether s is a known loop state.
func (s LoopStateName) IsKnown() bool {
	for _, k := range AllLoopStateNames {
		if s == k {
			return true
		}
	}
	return false
}

// IsTerminal reports whether s is a terminal loop state: done, stalled, or
// terminated.
func (s LoopStateName) IsTerminal() bool {
	switch s {
	case LoopDone, LoopStalled, LoopTerminated:
		return true
	default:
		return false
	}
}

// RunTerminationReason explains why a pipeline run terminated (tier 2 of the
// three-tier exit model).
type RunTerminationReason string

// Known run termination reasons.
const (
	TerminationCompleted    RunTerminationReason = "completed"
	TerminationStageFailure RunTerminationReason = "stage_failure"
	TerminationManualCancel RunTerminationReason = "manual_cancel"
	TerminationConfigChange RunTerminationReason = "config_change"
	TerminationOutdated     RunTerminationReason = "outdated"
	TerminationWorkerDead   RunTerminationReason = "worker_dead"
	// TerminationConverged marks stall-window convergence: the last
	// stallWindow consecutive runs in this loop produced the same set of
	// finding fingerprints, so the loop hit a fixpoint and terminates as
	// stalled rather than ping-ponging indefinitely.
	TerminationConverged RunTerminationReason = "converged"
	// TerminationDonePredicateUnmet marks an honest stall: every stage reached a
	// terminal state, but the pipeline's configured `done` predicate evaluated
	// false (e.g. open findings remain) and no `stalled` predicate matched. The
	// run terminates as stalled rather than being reported completed.
	TerminationDonePredicateUnmet RunTerminationReason = "done_predicate_unmet"
)

// AllRunTerminationReasons lists every known run termination reason.
var AllRunTerminationReasons = []RunTerminationReason{
	TerminationCompleted, TerminationStageFailure, TerminationManualCancel,
	TerminationConfigChange, TerminationOutdated, TerminationWorkerDead, TerminationConverged,
	TerminationDonePredicateUnmet,
}

// IsKnown reports whether r is a known run termination reason.
func (r RunTerminationReason) IsKnown() bool {
	for _, k := range AllRunTerminationReasons {
		if r == k {
			return true
		}
	}
	return false
}

// ArtifactStatus is an artifact's lifecycle status.
type ArtifactStatus string

// Known artifact statuses.
const (
	ArtifactStatusOpen        ArtifactStatus = "open"
	ArtifactStatusDismissed   ArtifactStatus = "dismissed"
	ArtifactStatusSentToAgent ArtifactStatus = "sent_to_agent"
	ArtifactStatusResolved    ArtifactStatus = "resolved"
)

// AllArtifactStatuses lists every known artifact status.
var AllArtifactStatuses = []ArtifactStatus{
	ArtifactStatusOpen, ArtifactStatusDismissed, ArtifactStatusSentToAgent, ArtifactStatusResolved,
}

// IsKnown reports whether s is a known artifact status.
func (s ArtifactStatus) IsKnown() bool {
	for _, k := range AllArtifactStatuses {
		if s == k {
			return true
		}
	}
	return false
}

// ArtifactKind distinguishes a finding artifact from a free-form JSON
// artifact.
type ArtifactKind string

// Known artifact kinds.
const (
	ArtifactKindFinding ArtifactKind = "finding"
	ArtifactKindJSON    ArtifactKind = "json"
)

// AllArtifactKinds lists every known artifact kind.
var AllArtifactKinds = []ArtifactKind{ArtifactKindFinding, ArtifactKindJSON}

// IsKnown reports whether k is a known artifact kind.
func (k ArtifactKind) IsKnown() bool {
	for _, known := range AllArtifactKinds {
		if k == known {
			return true
		}
	}
	return false
}

// WorkspaceMode is the workspace class a stage runs in.
//
//   - WorkspaceSharedRO (default for agent/builtin): one detached worktree per
//     run, shared by every shared-ro stage. Not expected to be mutated.
//   - WorkspaceIsolatedRW (default for command): fresh detached worktree per
//     stage at the same SHA, destroyed on terminal status. Safe for stages
//     that write files.
//
// The empty string means "unset": the default is resolved later (by the
// scheduler/executor task, not this package) based on the stage's executor
// kind.
type WorkspaceMode string

// Known workspace modes.
const (
	WorkspaceSharedRO   WorkspaceMode = "shared-ro"
	WorkspaceIsolatedRW WorkspaceMode = "isolated-rw"
)

// AllWorkspaceModes lists every known non-empty workspace mode.
var AllWorkspaceModes = []WorkspaceMode{WorkspaceSharedRO, WorkspaceIsolatedRW}

// IsKnown reports whether m is empty (unset) or a known workspace mode.
func (m WorkspaceMode) IsKnown() bool {
	if m == "" {
		return true
	}
	for _, k := range AllWorkspaceModes {
		if m == k {
			return true
		}
	}
	return false
}

// FindingsFilename is the file stages drop in {workspacePath}/.ao/ for
// findings discovery by convention.
const FindingsFilename = "pipeline-findings.jsonl"

// ============================================================================
// Pipeline configuration
// ============================================================================

// StageTrigger lists the events that fire a stage.
type StageTrigger struct {
	On []StageTriggerEvent `json:"on" yaml:"on"`
}

// StageExecutor is a single tagged struct covering all three executor kinds
// (agent, command, builtin) since it is parsed straight out of YAML. Config
// validation enforces the required fields per Kind and rejects fields that
// belong to another kind (e.g. Command set on an agent executor is an
// error), which gives clearer editor feedback than the old Zod schema (which
// silently stripped unknown fields).
type StageExecutor struct {
	Kind ExecutorKind `json:"kind" yaml:"kind"`

	// Agent fields (Kind == ExecutorAgent).
	Plugin string   `json:"plugin,omitempty" yaml:"plugin,omitempty"`
	Mode   TaskMode `json:"mode,omitempty" yaml:"mode,omitempty"`

	// Command fields (Kind == ExecutorCommand).
	Command string            `json:"command,omitempty" yaml:"command,omitempty"`
	Args    []string          `json:"args,omitempty" yaml:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty" yaml:"env,omitempty"`
	// Cwd is the working directory relative to the stage workspace.
	Cwd string `json:"cwd,omitempty" yaml:"cwd,omitempty"`

	// Builtin field (Kind == ExecutorBuiltin).
	Name BuiltinName `json:"name,omitempty" yaml:"name,omitempty"`

	// Config is shared by the agent and builtin kinds: free-form executor
	// config (e.g. builtin "router"/"compose" options, or agent-plugin
	// specific settings).
	Config map[string]any `json:"config,omitempty" yaml:"config,omitempty"`
}

// TaskSpec is the task fed to a stage's executor.
type TaskSpec struct {
	// Prompt is injected into the spawned agent session, or is the main
	// script body for a command executor.
	Prompt string `json:"prompt,omitempty" yaml:"prompt,omitempty"`
	// OutputSchema optionally describes the expected JSON outputs of the
	// stage.
	OutputSchema map[string]any `json:"outputSchema,omitempty" yaml:"outputSchema,omitempty"`
	// Inputs are free-form named inputs available to the stage.
	Inputs map[string]any `json:"inputs,omitempty" yaml:"inputs,omitempty"`
}

// StagePolicy configures merge-blocking and stall-convergence behavior for a
// stage.
type StagePolicy struct {
	BlocksMerge *bool `json:"blocksMerge,omitempty" yaml:"blocksMerge,omitempty"`
	// StallWindow is the convergence window: the number of recent runs whose
	// findings must be unchanged for the loop to be considered stalled.
	StallWindow *int `json:"stallWindow,omitempty" yaml:"stallWindow,omitempty"`
}

// StageBudget caps a stage's spend and wall-clock duration.
type StageBudget struct {
	MaxUSD        *float64 `json:"maxUsd,omitempty" yaml:"maxUsd,omitempty"`
	MaxDurationMs *int64   `json:"maxDurationMs,omitempty" yaml:"maxDurationMs,omitempty"`
}

// StageRoutes is a stage's conditional activation predicate. When set and
// the predicate evaluates to false (after every referenced upstream stage is
// terminal), the stage is marked skipped instead of started. When unset, the
// default is "all dependsOn stages must have succeeded".
type StageRoutes struct {
	When Predicate `json:"when" yaml:"when"`
}

// ExitPredicates are the optional typed-predicate decisions for a run's exit
// and merge-blocking state.
type ExitPredicates struct {
	// Done: the run terminates as "done" when this predicate is true after
	// every stage reaches a terminal state.
	Done *Predicate `json:"done,omitempty" yaml:"done,omitempty"`
	// Stalled: the run terminates as "stalled" when this predicate is true
	// after every stage reaches a terminal state.
	Stalled *Predicate `json:"stalled,omitempty" yaml:"stalled,omitempty"`
	// BlocksMerge: engine-level "this run blocks merge" decision, consulted
	// by the SCM integration; not enforced by the reducer itself.
	BlocksMerge *Predicate `json:"blocksMerge,omitempty" yaml:"blocksMerge,omitempty"`
}

// Stage is one node in a pipeline's DAG.
type Stage struct {
	Name     string        `json:"name" yaml:"name"`
	Trigger  StageTrigger  `json:"trigger" yaml:"trigger"`
	Executor StageExecutor `json:"executor" yaml:"executor"`
	Task     TaskSpec      `json:"task,omitempty" yaml:"task,omitempty"`

	Policy *StagePolicy `json:"policy,omitempty" yaml:"policy,omitempty"`
	Budget *StageBudget `json:"budget,omitempty" yaml:"budget,omitempty"`

	// TimeoutMs is advisory; the engine treats it as a hint, not a hard cap.
	TimeoutMs *int64 `json:"timeoutMs,omitempty" yaml:"timeoutMs,omitempty"`
	Retries   *int   `json:"retries,omitempty" yaml:"retries,omitempty"`
	// MaxLoopRounds is a per-stage loop cap (locked decision: not
	// pipeline-global).
	MaxLoopRounds *int `json:"maxLoopRounds,omitempty" yaml:"maxLoopRounds,omitempty"`

	// DependsOn lists stage names this stage waits for before it can be
	// evaluated. The named stages must reach a terminal status before the
	// scheduler considers this stage. Unknown names and cycles are rejected
	// at config load.
	DependsOn []string `json:"dependsOn,omitempty" yaml:"dependsOn,omitempty"`

	// Routes is this stage's conditional activation predicate. See
	// StageRoutes for semantics.
	Routes *StageRoutes `json:"routes,omitempty" yaml:"routes,omitempty"`

	// Workspace is this stage's workspace class. Empty means "use the
	// default for the executor kind", resolved later. See WorkspaceMode.
	Workspace WorkspaceMode `json:"workspace,omitempty" yaml:"workspace,omitempty"`
}

// Pipeline is a full pipeline definition: the DAG of stages plus
// pipeline-level policy.
type Pipeline struct {
	// ID is assigned by the store when the definition is saved; it is never
	// part of the authored YAML document.
	ID   ID     `json:"id" yaml:"-"`
	Name string `json:"name" yaml:"name"`

	// Scope mirrors the pipeline-v3 spec (see Scope). v1 accepts
	// only the empty string or ScopeWorker; ScopeOrchestrator and
	// ScopeWorkstream are deferred to phase 2.
	Scope Scope `json:"scope,omitempty" yaml:"scope,omitempty"`

	Stages []Stage `json:"stages" yaml:"stages"`

	// MaxConcurrentStages defaults to 1 when unset; the engine enforces
	// serial execution in that case.
	MaxConcurrentStages *int `json:"maxConcurrentStages,omitempty" yaml:"maxConcurrentStages,omitempty"`

	// AllowForkPRs opts in to running command-executor stages for pull
	// requests opened from forks. Defaults to false: fork-PR command stages
	// are skipped before any subprocess is spawned. Only applies to the
	// command executor.
	AllowForkPRs *bool `json:"allowForkPRs,omitempty" yaml:"allowForkPRs,omitempty"`

	// ExitPredicates optionally overrides the v0 hardcoded run-exit rules.
	ExitPredicates *ExitPredicates `json:"exitPredicates,omitempty" yaml:"exitPredicates,omitempty"`
}

// ============================================================================
// Runtime state
// ============================================================================
//
// The types below describe engine runtime state (RunState, LoopState, ...).
// They are JSON-serialized for persistence but are never parsed from YAML
// config, so they carry only json tags.

// RunContext carries the pull-request identity and session facts for a run. It
// is populated once at trigger time (from PRFacts in the trigger bridge, or the
// session/head SHA a manual trigger has) and threaded to every stage executor,
// so agent stages spawn on the PR branch with PR facts in their prompt and
// command stages receive AO_PR_* env vars. PR fields are empty for manual
// triggers with no PR. It is JSON-serializable because it is persisted as part
// of RunState.
type RunContext struct {
	PRNumber     int    `json:"prNumber,omitempty"`
	PRURL        string `json:"prUrl,omitempty"`
	SourceBranch string `json:"sourceBranch,omitempty"`
	TargetBranch string `json:"targetBranch,omitempty"`
	HeadSHA      string `json:"headSha,omitempty"`
	SessionID    string `json:"sessionId,omitempty"`
	IssueID      string `json:"issueId,omitempty"`
	// IsFromFork mirrors domain.PRFacts fork provenance tri-state: nil =
	// unknown, false = same-repo PR (or no PR), true = the PR head lives in a
	// fork.
	IsFromFork *bool `json:"isFromFork,omitempty"`
}

// StageState is one stage's runtime state within a run.
type StageState struct {
	StageRunID StageRunID   `json:"stageRunId"`
	Status     StageStatus  `json:"status"`
	Attempt    int          `json:"attempt"`
	Verdict    Verdict      `json:"verdict,omitempty"`
	Artifacts  []ArtifactID `json:"artifacts,omitempty"`

	StartedAt   *time.Time `json:"startedAt,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	// Deadline is stamped on STAGE_STARTED (StartedAt + the stage's TimeoutMs, or
	// DefaultStageTimeout when unset). The reducer's TICK arm fails any running
	// stage whose deadline has passed, so an executor that never reports terminal
	// cannot wedge the run forever. Cleared when the stage is (re-)pended.
	Deadline *time.Time `json:"deadline,omitempty"`

	ErrorMessage string `json:"errorMessage,omitempty"`
	// Output is a capped tail of the stage's combined stdout+stderr (command
	// stages only), surfaced in the run detail. Empty for stages with no
	// subprocess output.
	Output string `json:"output,omitempty"`
}

// RunState is one pipeline run's full runtime state.
type RunState struct {
	RunID        RunID  `json:"runId"`
	PipelineID   ID     `json:"pipelineId"`
	PipelineName string `json:"pipelineName"`
	SessionID    string `json:"sessionId"`

	// PipelineConfigSnapshot is frozen at run-create; config changes during
	// a run terminate the run rather than mutating it in place.
	PipelineConfigSnapshot Pipeline `json:"pipelineConfigSnapshot"`

	HeadSHA string `json:"headSha"`

	// Context carries per-run PR identity, issue id, and session facts,
	// populated once at trigger time and threaded to every stage executor.
	Context RunContext `json:"context,omitempty"`

	LoopState         LoopStateName        `json:"loopState"`
	TerminationReason RunTerminationReason `json:"terminationReason,omitempty"`
	LoopRounds        int                  `json:"loopRounds"`

	// BlocksMerge is the terminal-time decision of whether this run blocks the
	// PR from merging. It is evaluated once, when the run reaches a terminal
	// loop state (see terminateRunFromState): true when a finally-failed stage's
	// policy opts into blocking, or the exitPredicates.blocksMerge predicate is
	// true. Runs superseded by an outdated/cancel/config-change termination never
	// block. The lifecycle merge-readiness path consults this on the most recent
	// settled run matching the PR (by URL + head SHA).
	BlocksMerge bool `json:"blocksMerge,omitempty"`

	// Stages is keyed by stage name. v1 has at most one entry per stage.
	Stages map[string]StageState `json:"stages"`

	// Findings are denormalized materialized finding artifacts, appended as
	// STAGE_COMPLETED events arrive, so predicate evaluation can answer
	// no_open_findings/finding_count_below without reading the store. JSON
	// artifacts are not mirrored here.
	Findings []Artifact `json:"findings,omitempty"`

	// Fingerprints are finding fingerprints accumulated during the run, used
	// by stall-window convergence detection.
	Fingerprints []string `json:"fingerprints,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// LoopState is the persistent per-session, per-pipeline loop's runtime
// state.
type LoopState struct {
	SessionID    string        `json:"sessionId"`
	PipelineName string        `json:"pipelineName"`
	LoopState    LoopStateName `json:"loopState"`
	LoopRounds   int           `json:"loopRounds"`
	LastSHA      string        `json:"lastSha"`
	CurrentRunID RunID         `json:"currentRunId,omitempty"`
	UpdatedAt    time.Time     `json:"updatedAt"`
}

// RunSummary is a compact run record used for stalled-detection across runs.
type RunSummary struct {
	RunID             RunID                `json:"runId"`
	LoopState         LoopStateName        `json:"loopState"`
	TerminationReason RunTerminationReason `json:"terminationReason,omitempty"`
	HeadSHA           string               `json:"headSha"`
	LoopRounds        int                  `json:"loopRounds"`
	// Fingerprints is the sorted, deduped list of artifact fingerprints from
	// the run, used by convergence detection.
	Fingerprints []string  `json:"fingerprints"`
	CreatedAt    time.Time `json:"createdAt"`
}

// EngineState is the engine-global state. Multiple in-flight runs may exist
// at once (e.g. an old run is being torn down while a new SHA spawns its
// replacement), so runs are keyed by RunID. Per-loop indices are kept
// separately from the per-run details.
type EngineState struct {
	Runs map[RunID]RunState `json:"runs"`
	// CurrentRunByLoop maps a loop key ("sessionId:pipelineName") to the
	// currently-active RunID.
	CurrentRunByLoop map[string]RunID `json:"currentRunByLoop"`
	// HistorySummaries maps a loop key to its ordered run history (oldest
	// first), used by convergence detection.
	HistorySummaries map[string][]RunSummary `json:"historySummaries"`
}

// LoopKey returns the session+pipeline key. It is used only to deduplicate
// per-session+pipeline dispatches (e.g. CONFIG_CHANGED fan-out); the per-run
// loop-identity index uses LoopKeyFor, which isolates runs by PR.
func LoopKey(sessionID, pipelineName string) string {
	return sessionID + ":" + pipelineName
}

// LoopKeyFor composes the per-run loop-identity key that indexes
// EngineState.CurrentRunByLoop and EngineState.HistorySummaries. The key is
// derived from what the run actually is, so runs stay isolated per PR:
//
//   - a run backed by a PR (ctx.PRURL set) keys per PR as
//     "sessionID:pipelineName:prURL", so sibling PRs on one session+pipeline
//     never collide (a NEW_SHA on PR-B cannot terminate PR-A's run);
//   - a manual run scoped to a session keys "sessionID:pipelineName";
//   - a manual run with no session keys "run:runID", so unscoped manual runs
//     never share the global ":pipelineName" key and no-op each other.
//
// Runs persisted before RunContext existed have an empty ctx but a non-empty
// sessionID, so they degrade to the historical "sessionID:pipelineName" shape,
// which is acceptable.
func LoopKeyFor(ctx RunContext, sessionID, pipelineName string, runID RunID) string {
	if ctx.PRURL != "" {
		return sessionID + ":" + pipelineName + ":" + ctx.PRURL
	}
	if sessionID != "" {
		return sessionID + ":" + pipelineName
	}
	return "run:" + string(runID)
}

// EmptyEngineState returns a zero-value EngineState with initialized maps.
func EmptyEngineState() EngineState {
	return EngineState{
		Runs:             map[RunID]RunState{},
		CurrentRunByLoop: map[string]RunID{},
		HistorySummaries: map[string][]RunSummary{},
	}
}

// PredicateCtx is the input to the predicate evaluator (built in a later
// task). All fields are read-only snapshots.
//
// Unlike the old TypeScript PredicateCtx, there is no workstream field in
// v1: pipeline-v3 workstream scope is deferred to phase 2, and the
// workstream-only predicate kinds were dropped from the DSL (see
// predicate.go).
type PredicateCtx struct {
	Run      *RunState
	History  []RunSummary
	Findings []Artifact
}

// ============================================================================
// Artifacts
// ============================================================================

// ArtifactInput is the payload a stage reports for one artifact: either a
// finding or a free-form JSON blob. It carries no envelope fields (those are
// assigned by the engine when the artifact is persisted; see Artifact).
type ArtifactInput struct {
	Kind ArtifactKind `json:"kind"`

	// Finding fields (Kind == ArtifactKindFinding).
	FilePath    string `json:"filePath,omitempty"`
	StartLine   int    `json:"startLine,omitempty"`
	EndLine     int    `json:"endLine,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	// Category is a free-form label, e.g. "security" | "correctness" |
	// "style" | ... | "general".
	Category string   `json:"category,omitempty"`
	Severity Severity `json:"severity,omitempty"`
	// Confidence is in [0.0, 1.0].
	Confidence float64 `json:"confidence,omitempty"`
	// AnchorSignature is a structural anchor (function/class name) for
	// fingerprint stability.
	AnchorSignature string `json:"anchorSignature,omitempty"`

	// JSON field (Kind == ArtifactKindJSON).
	Data map[string]any `json:"data,omitempty"`
}

// Artifact is a persisted ArtifactInput plus its engine-assigned envelope.
type Artifact struct {
	ArtifactInput

	ArtifactID    ArtifactID `json:"artifactId"`
	PipelineRunID RunID      `json:"pipelineRunId"`
	StageRunID    StageRunID `json:"stageRunId"`
	StageName     string     `json:"stageName"`

	Fingerprint string         `json:"fingerprint,omitempty"`
	Status      ArtifactStatus `json:"status"`

	CreatedAt     time.Time  `json:"createdAt"`
	SentToAgentAt *time.Time `json:"sentToAgentAt,omitempty"`

	// BelowConfidenceThreshold is set when the finding's confidence is below
	// the pipeline/stage threshold.
	BelowConfidenceThreshold bool `json:"belowConfidenceThreshold,omitempty"`
}
