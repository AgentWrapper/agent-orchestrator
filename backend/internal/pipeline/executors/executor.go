// Package executors runs a pipeline stage's work: an agent session, a
// shelled-out command, or an engine-internal builtin (router/compose). Each
// executor is driven through the same start/poll/cancel contract so the T5
// engine can push every stage kind through one inflight loop, and every
// dependency the executors touch (session manager, subprocess runner, artifact
// store, message sink) is an injected interface so the whole package is
// mockable with no real sessions or shells in unit tests.
//
// The package holds NO reducer, scheduler, store, or engine wiring; those land
// in sibling tasks. It also does not provision worktrees: a resolved workspace
// path arrives via the linked session, and teardown-on-crash is the engine's
// job (spec §9 note 9).
package executors

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// OutcomeStatus is the lifecycle of a polled stage: still running, or a
// terminal completed/failed. It is distinct from pipeline.StageStatus (the
// reducer's richer lifecycle) because an executor only ever reports these
// three; the reducer maps them onto its own states.
type OutcomeStatus string

// Known outcome statuses.
const (
	OutcomeRunning   OutcomeStatus = "running"
	OutcomeCompleted OutcomeStatus = "completed"
	OutcomeFailed    OutcomeStatus = "failed"
)

// Observation is a side-channel telemetry event an executor asks the engine to
// route through an EMIT_OBSERVATION effect (e.g. a findings-truncation warning
// or a fork-PR skip). It never affects the stage verdict.
type Observation struct {
	Name string
	Data map[string]any
	// Note is an optional human-readable one-line summary of this observation. When
	// set, the engine appends it to the stage's Notes so the run detail can explain
	// an otherwise silent decision (fork skip, findings truncated, exit-mode
	// fallback). Empty for observations that are telemetry-only.
	Note string
}

// Outcome is the result of polling a running stage. Status is the only field
// always set; Verdict/Artifacts are meaningful on OutcomeCompleted, and
// ErrorMessage on OutcomeFailed. Observations may accompany any terminal
// status.
type Outcome struct {
	Status    OutcomeStatus
	Verdict   pipeline.Verdict
	Artifacts []pipeline.ArtifactInput
	// StatusChanges are {kind:"status"} records the stage emitted to flip
	// existing findings' lifecycle status by fingerprint. They ride the
	// STAGE_COMPLETED event so the reducer applies them before the exit decision.
	// Meaningful on OutcomeCompleted.
	StatusChanges []pipeline.FindingStatusChange
	Observations  []Observation
	ErrorMessage  string
	// Output is a capped tail of the stage's combined stdout+stderr, surfaced in
	// the run detail. Set by the command executor on both success and failure;
	// empty for executor kinds that produce no subprocess output.
	Output string
	// SessionID is the AO session this stage ran in, so the run detail can link
	// straight to what the stage did. The agent executor sets it (the session it
	// spawned) on both completed and failed outcomes; empty for command/builtin
	// stages, which do not own a session.
	SessionID string
}

// Handle is an opaque running-stage token returned by Start and threaded back
// into Poll and Cancel. Each executor kind returns its own concrete type; the
// engine treats it as opaque and only reads the identity accessors.
type Handle interface {
	RunID() pipeline.RunID
	StageRunID() pipeline.StageRunID
	StageName() string
}

// StartInput is everything an executor needs to begin a stage. Not every field
// is used by every kind: agent uses Prompt context + ProjectID/IssueID;
// command uses LinkedSessionID (cwd + fork gate) + AllowForkPRs; builtin uses
// LinkedSessionID (routing) + the injected artifact store keyed on
// Stage.DependsOn.
type StartInput struct {
	PipelineName string
	ProjectID    string
	RunID        pipeline.RunID
	StageRunID   pipeline.StageRunID
	Stage        pipeline.Stage
	// IssueID scopes the spawned agent session, if any.
	IssueID string
	// LoopRound is surfaced in the agent prompt when non-nil.
	LoopRound *int
	// LinkedSessionID is the worker session this run is scoped to. The command
	// executor reads its workspace + PR fork status; the builtin router
	// delivers messages to it.
	LinkedSessionID string
	// RoutingTargetSessionID overrides the router's delivery destination. Unset
	// in v1 (worker-only); it falls back to LinkedSessionID. Kept as a seam for
	// the phase-2 workstream/orchestrator scopes.
	RoutingTargetSessionID string
	// AllowForkPRs opts command stages into running for fork PRs. Default false
	// skips them before any subprocess spawns.
	AllowForkPRs bool
	// Context carries the run's PR identity and session facts. Agent stages use
	// SourceBranch to spawn on the PR branch and render a PR block in the
	// prompt; command stages surface it as AO_PR_* env vars.
	Context pipeline.RunContext
	// UpstreamFindings are the finding artifacts produced by this stage's
	// dependsOn stages earlier in the run, resolved by the engine from the run's
	// materialized findings. The agent executor renders them into an "## Upstream
	// findings" prompt section so a summarize/verify stage can act on them and
	// emit {kind:"status"} records referencing their fingerprints. Empty when the
	// stage has no dependsOn or no upstream findings exist.
	UpstreamFindings []pipeline.Artifact
}

// StageExecutor is the contract the engine drives. Start begins the work and
// returns a handle; Poll reports progress or a terminal outcome; Cancel tears
// the stage down early. Implementations must make Poll and Cancel safe to call
// after a terminal Poll (idempotent teardown).
type StageExecutor interface {
	Start(ctx context.Context, in StartInput) (Handle, error)
	Poll(ctx context.Context, h Handle) (Outcome, error)
	Cancel(ctx context.Context, h Handle) error
}

// stageIdentity is embedded in every concrete handle to satisfy the Handle
// accessors without repetition.
type stageIdentity struct {
	runID      pipeline.RunID
	stageRunID pipeline.StageRunID
	stageName  string
}

func (s stageIdentity) RunID() pipeline.RunID           { return s.runID }
func (s stageIdentity) StageRunID() pipeline.StageRunID { return s.stageRunID }
func (s stageIdentity) StageName() string               { return s.stageName }

// Set routes a stage to the right executor by its executor kind and presents
// the three as a single StageExecutor the engine drives uniformly. Start
// dispatches by kind and tags the returned handle with its owner so Poll and
// Cancel route back to the same executor.
type Set struct {
	agent   StageExecutor
	command StageExecutor
	builtin StageExecutor
}

// NewSet builds the routing facade over the three kind executors.
func NewSet(agent, command, builtin StageExecutor) *Set {
	return &Set{agent: agent, command: command, builtin: builtin}
}

var _ StageExecutor = (*Set)(nil)

// setHandle wraps a kind executor's handle with the executor that owns it.
type setHandle struct {
	owner StageExecutor
	inner Handle
}

func (h setHandle) RunID() pipeline.RunID           { return h.inner.RunID() }
func (h setHandle) StageRunID() pipeline.StageRunID { return h.inner.StageRunID() }
func (h setHandle) StageName() string               { return h.inner.StageName() }

func (s *Set) executorFor(kind pipeline.ExecutorKind) (StageExecutor, error) {
	switch kind {
	case pipeline.ExecutorAgent:
		return s.agent, nil
	case pipeline.ExecutorCommand:
		return s.command, nil
	case pipeline.ExecutorBuiltin:
		return s.builtin, nil
	default:
		return nil, fmt.Errorf("no executor for kind %q", kind)
	}
}

// Start dispatches to the executor for the stage's kind.
func (s *Set) Start(ctx context.Context, in StartInput) (Handle, error) {
	exec, err := s.executorFor(in.Stage.Executor.Kind)
	if err != nil {
		return nil, err
	}
	h, err := exec.Start(ctx, in)
	if err != nil {
		return nil, err
	}
	return setHandle{owner: exec, inner: h}, nil
}

// Poll routes to the executor that started the stage.
func (s *Set) Poll(ctx context.Context, h Handle) (Outcome, error) {
	sh, ok := h.(setHandle)
	if !ok {
		return Outcome{}, fmt.Errorf("executor set: unexpected handle type %T", h)
	}
	return sh.owner.Poll(ctx, sh.inner)
}

// Cancel routes to the executor that started the stage.
func (s *Set) Cancel(ctx context.Context, h Handle) error {
	sh, ok := h.(setHandle)
	if !ok {
		return fmt.Errorf("executor set: unexpected handle type %T", h)
	}
	return sh.owner.Cancel(ctx, sh.inner)
}
