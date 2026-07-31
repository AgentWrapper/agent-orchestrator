package executors

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// PollState is what one poll of a running stage observed. It is deliberately
// smaller than the outcome taxonomy (spec section 7): an executor reports what
// it saw, and the driver decides what that means for the stage. `succeeded`,
// `no_output`, `timed_out`, `cancelled` and `skipped` are all driver verdicts,
// never executor observations.
type PollState string

// Every poll state.
const (
	// PollRunning means the process or session is still working.
	PollRunning PollState = "running"
	// PollSignaledDone means the agent ran `ao pipeline done`.
	PollSignaledDone PollState = "signaled_done"
	// PollSignaledFail means the agent ran `ao pipeline fail`.
	PollSignaledFail PollState = "signaled_fail"
	// PollExited means a command stage's process finished; ExitCode carries the
	// status, which for a command stage IS the outcome (spec section 6.1).
	PollExited PollState = "exited"
	// PollIdle means an agent session is alive but has stopped working, so a
	// missing signal will not arrive on its own.
	PollIdle PollState = "idle"
	// PollGone means the agent session no longer exists.
	PollGone PollState = "gone"
)

// Poll is one observation of a running stage. ExitCode is meaningful only for
// PollExited. Reason is a short human-readable note (a fail signal's reason, a
// killing signal, a wait failure) surfaced in run detail; empty is normal.
type Poll struct {
	State    PollState
	ExitCode int
	Reason   string
}

// StartInput is everything an executor needs to begin a stage. The driver has
// already resolved every field: the stage is the frozen copy from the run
// folder, the workspace exists, and Env is the fully built ambient set (spec
// section 12.2). No executor reads configuration of its own.
type StartInput struct {
	ProjectID string
	RunID     pipeline.RunID
	// RunDir is the run folder, <AO_DATA_DIR>/pipelines/<project>/<run>.
	RunDir string
	// Stage is the frozen definition's copy of the stage, so editing the
	// pipeline mid-run cannot change what runs.
	Stage pipeline.Stage
	// Attempt is 1, or 2 for the one nudge a stage may get (spec section 7.1).
	Attempt int
	Subject pipeline.Subject
	// WorkspacePath is the resolved tree the stage runs in, already provisioned.
	WorkspacePath string
	// Env is the ambient variable set, built by the driver.
	Env map[string]string
	// Credentials are resolved credential values. Command stages only: they
	// never enter an agent's environment (spec section 8), and the schema
	// rejects `credentials:` on an agent stage so the tier cannot be regressed
	// by convention alone.
	Credentials map[string]string
	// LogPath is <run>/stage-logs/<stage>.log, from RunFolder.LogPath. Both
	// executors capture one; a failed stage's reason is otherwise gone by the
	// time anyone opens run detail (spec section 6.1).
	LogPath string
}

// Handle is an opaque running-stage token returned by Start and threaded back
// into Poll, Cancel and Interrupt. Each executor kind returns its own concrete
// type; the driver treats it as opaque and only reads the identity accessors.
type Handle interface {
	RunID() pipeline.RunID
	StageID() string
	Attempt() int
}

// OutputTailer is implemented by handles that kept a capped copy of the stage's
// output in memory for the run-detail DTO. The complete stream always lives on
// disk at StartInput.LogPath; this is only what can be shown without reading a
// file. truncated reports that output past the cap was dropped from the copy.
type OutputTailer interface {
	OutputTail() (text string, truncated bool)
}

// ProcessGroupHolder is implemented by handles whose stage runs in an OS
// process group of its own. An agent stage runs in a session and implements
// nothing here: session teardown already owns it.
type ProcessGroupHolder interface{ ProcessGroup() int }

// stageIdentity is embedded in every concrete handle to satisfy the Handle
// accessors without repetition.
type stageIdentity struct {
	runID   pipeline.RunID
	stageID string
	attempt int
}

func (s stageIdentity) RunID() pipeline.RunID { return s.runID }
func (s stageIdentity) StageID() string       { return s.stageID }
func (s stageIdentity) Attempt() int          { return s.attempt }

// StageExecutor is the contract the engine drives. Start begins the work and
// returns a handle; Poll reports what the stage is doing; Cancel tears it down;
// Interrupt stops the work but preserves anything worth keeping.
//
// Poll, Cancel and Interrupt must be safe to call after a terminal Poll, and
// safe to call twice: the reducer can cancel a stage that has already settled.
type StageExecutor interface {
	Start(ctx context.Context, in StartInput) (Handle, error)
	Poll(ctx context.Context, h Handle) (Poll, error)
	Cancel(ctx context.Context, h Handle) error
	// Interrupt stops the stage's work on a deadline while leaving an agent's
	// session alive so a human can see what it was doing (spec section 7.2).
	// For a command stage there is no session, so it is Cancel.
	Interrupt(ctx context.Context, h Handle) error
}

// Set routes a stage to the executor for its kind and presents both as a single
// StageExecutor the engine drives uniformly. Start tags the returned handle with
// its owner so Poll, Cancel and Interrupt route back to the executor that made
// it.
//
// The fields are exported so wiring reads as `Set{Agent: ..., Command: ...}`.
type Set struct{ Agent, Command StageExecutor }

var _ StageExecutor = (*Set)(nil)

// setHandle wraps a kind executor's handle with the executor that owns it.
type setHandle struct {
	owner StageExecutor
	inner Handle
}

func (h setHandle) RunID() pipeline.RunID { return h.inner.RunID() }
func (h setHandle) StageID() string       { return h.inner.StageID() }
func (h setHandle) Attempt() int          { return h.inner.Attempt() }

// OutputTail forwards to the wrapped handle when it kept one, so the DTO does
// not have to unwrap the routing layer.
func (h setHandle) OutputTail() (string, bool) {
	if tailer, ok := h.inner.(OutputTailer); ok {
		return tailer.OutputTail()
	}
	return "", false
}

// SessionID forwards to the wrapped handle when the stage runs in a session, so
// the driver can name it in StageLaunched and in the kill-on decision without
// unwrapping the routing layer. A command stage has no session and returns "".
func (h setHandle) SessionID() string {
	if holder, ok := h.inner.(SessionHolder); ok {
		return holder.SessionID()
	}
	return ""
}

// ProcessGroup forwards to the wrapped handle when the stage runs in one, so
// the driver can persist it from StageLaunched without unwrapping the routing
// layer. An agent stage has no process group and returns 0.
func (h setHandle) ProcessGroup() int {
	if holder, ok := h.inner.(ProcessGroupHolder); ok {
		return holder.ProcessGroup()
	}
	return 0
}

func (s *Set) executorFor(kind pipeline.ExecutorKind) (StageExecutor, error) {
	switch kind {
	case pipeline.ExecutorAgent:
		if s.Agent == nil {
			return nil, fmt.Errorf("executor set: no agent executor wired")
		}
		return s.Agent, nil
	case pipeline.ExecutorCommand:
		if s.Command == nil {
			return nil, fmt.Errorf("executor set: no command executor wired")
		}
		return s.Command, nil
	default:
		return nil, fmt.Errorf("executor set: no executor for kind %q", kind)
	}
}

// Start dispatches to the executor for the stage's kind.
func (s *Set) Start(ctx context.Context, in StartInput) (Handle, error) {
	owner, err := s.executorFor(in.Stage.Executor)
	if err != nil {
		return nil, err
	}
	h, err := owner.Start(ctx, in)
	if err != nil {
		return nil, err
	}
	return setHandle{owner: owner, inner: h}, nil
}

// Poll routes to the executor that started the stage.
func (s *Set) Poll(ctx context.Context, h Handle) (Poll, error) {
	sh, ok := h.(setHandle)
	if !ok {
		return Poll{}, fmt.Errorf("executor set: unexpected handle type %T", h)
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

// Interrupt routes to the executor that started the stage.
func (s *Set) Interrupt(ctx context.Context, h Handle) error {
	sh, ok := h.(setHandle)
	if !ok {
		return fmt.Errorf("executor set: unexpected handle type %T", h)
	}
	return sh.owner.Interrupt(ctx, sh.inner)
}
