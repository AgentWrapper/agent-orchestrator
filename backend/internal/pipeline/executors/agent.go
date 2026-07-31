package executors

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// SpawnRequest is the narrow spawn payload the agent executor hands the session
// manager. It carries only what a stage needs; the engine's adapter maps it
// onto ports.SpawnConfig.
type SpawnRequest struct {
	ProjectID string
	// RunID marks the session as pipeline-spawned on its own metadata, which is
	// what the session trigger bridge reads as its loop guard: a pipeline agent
	// going idle must not fire the session pipelines.
	RunID string
	// Harness is the stage's `agent:` key. Empty lets the project default pick.
	Harness string
	// Prompt is the v2 preamble followed by the stage's own prompt.
	Prompt string
	// WorkspacePath is the tree the driver already provisioned for this stage
	// (spec section 5). The session runs there instead of resolving one of its
	// own, which is what makes `workspace: run` and `inherit` mean anything.
	WorkspacePath string
	// Env is the ambient variable set (spec section 12.2), passed straight into
	// ports.SpawnConfig.Env. AO_RUN_ID and AO_STAGE ride in here, which is how
	// `ao pipeline done` resolves the stage it is settling.
	Env map[string]string
	// DisplayName labels the session in the sidebar.
	DisplayName string
}

// SpawnedSession is what the session manager returns for a fresh spawn. The
// path comes back because the adapter, not this executor, has the last word on
// where the session actually landed.
type SpawnedSession struct {
	SessionID     string
	WorkspacePath string
}

// SessionSnapshot is the subset of session state the executor polls: how busy
// the agent is, whether the session row went terminal, and whether any of that
// activity was ever reported.
type SessionSnapshot struct {
	Activity   domain.ActivityState
	Terminated bool
	// Signalled reports whether a hook callback has arrived for this spawn.
	// A session row is seeded `idle` when it is created and stays there until
	// the harness reports, so idle before the first callback is the spawn
	// placeholder rather than an observation of the agent.
	Signalled bool
}

// SessionSpawner is the session-manager seam the agent executor needs. The
// concrete Manager never enters this package; the engine wires an adapter
// (Task 15).
type SessionSpawner interface {
	Spawn(ctx context.Context, req SpawnRequest) (SpawnedSession, error)
	// Get returns a snapshot and whether the session still exists.
	Get(ctx context.Context, sessionID string) (SessionSnapshot, bool, error)
	// Interrupt stops the agent's work while leaving the session record and its
	// scrollback alive. This is the timed_out path (spec section 7.2).
	Interrupt(ctx context.Context, sessionID string) error
	// Kill tears the session down. Idempotent; a missing session is not an error.
	Kill(ctx context.Context, sessionID string) error
}

// SessionMessenger is the nudge delivery seam. It is the driver's, not this
// executor's: the reducer emits NudgeStage, the engine sends the message and
// feeds NudgeDelivered back (spec section 7.1). It lives here with the other
// session seams so the engine's adapters implement one vocabulary.
type SessionMessenger interface {
	Alive(ctx context.Context, sessionID string) (bool, error)
	Send(ctx context.Context, sessionID, message string) error
}

// SignalReader reads the latest `ao pipeline done|fail` a stage recorded.
// Task 11's Manager implements it over the signal registry.
type SignalReader interface {
	LatestSignal(runID pipeline.RunID, stageID string) (pipeline.StageSignal, bool)
}

// SessionHolder is implemented by handles backed by an agent session, so the
// driver can name the session in StageLaunched and in the kill-on decision
// without knowing which executor produced the handle.
type SessionHolder interface{ SessionID() string }

// agentHandle is the running-stage token for an agent stage.
type agentHandle struct {
	stageIdentity
	sessionID string

	// mu guards reportedAt, the CreatedAt of the last signal Poll turned into a
	// terminal state. A nudged stage keeps the same session and the same signal
	// row, so re-reporting the stale signal would settle the stage before the
	// agent had a chance to answer the nudge. Only a strictly newer signal is
	// reported again.
	mu         sync.Mutex
	reportedAt time.Time
}

// SessionID implements SessionHolder.
func (h *agentHandle) SessionID() string { return h.sessionID }

var _ SessionHolder = (*agentHandle)(nil)

// AgentExecutor runs an agent stage as a real, visible AO session: spawn it
// with the ambient env and a pointer-style preamble, then watch for the
// agent's own settlement signal. It harvests nothing: the whole contract is the
// signal plus, when `produces:` is declared, the file the driver verifies
// (spec section 6.2).
type AgentExecutor struct {
	sessions SessionSpawner
	signals  SignalReader
}

// NewAgentExecutor builds the agent executor over the session and signal seams.
func NewAgentExecutor(sessions SessionSpawner, signals SignalReader) *AgentExecutor {
	return &AgentExecutor{sessions: sessions, signals: signals}
}

var _ StageExecutor = (*AgentExecutor)(nil)

// Start spawns the stage's session. There is no log file for an agent stage:
// its record is the session's own scrollback, which outlives the stage on every
// outcome that keeps the session.
func (e *AgentExecutor) Start(ctx context.Context, in StartInput) (Handle, error) {
	if in.Stage.Executor != pipeline.ExecutorAgent {
		return nil, fmt.Errorf("agent executor cannot start stage %q with executor %q", in.Stage.ID, in.Stage.Executor)
	}
	// The schema forbids `credentials:` on an agent stage (spec section 8). This
	// is the runtime half of that rule: a tier separation enforced only by
	// validation is one bad call site away from being gone.
	if len(in.Credentials) > 0 {
		return nil, fmt.Errorf("agent stage %q must not receive credentials", in.Stage.ID)
	}

	session, err := e.sessions.Spawn(ctx, SpawnRequest{
		ProjectID:     in.ProjectID,
		RunID:         string(in.RunID),
		Harness:       in.Stage.Agent,
		Prompt:        buildAgentPrompt(in),
		WorkspacePath: in.WorkspacePath,
		Env:           in.Env,
		DisplayName:   fmt.Sprintf("%s/%s", in.RunID, in.Stage.ID),
	})
	if err != nil {
		return nil, fmt.Errorf("agent stage %q: spawn session: %w", in.Stage.ID, err)
	}
	if session.SessionID == "" {
		return nil, fmt.Errorf("agent stage %q: spawn returned no session id", in.Stage.ID)
	}

	return &agentHandle{
		stageIdentity: stageIdentity{runID: in.RunID, stageID: in.Stage.ID, attempt: in.Attempt},
		sessionID:     session.SessionID,
	}, nil
}

// Poll reports the signal if there is a new one, and otherwise what the session
// is doing. Signal always beats activity: an agent that signalled and then went
// idle has settled, and reading that as "idle without a signal" would nudge a
// stage that is already done.
func (e *AgentExecutor) Poll(ctx context.Context, h Handle) (Poll, error) {
	handle, ok := h.(*agentHandle)
	if !ok {
		return Poll{}, fmt.Errorf("agent executor: unexpected handle type %T", h)
	}

	if out, signalled := e.pollSignal(handle); signalled {
		return out, nil
	}

	snap, exists, err := e.sessions.Get(ctx, handle.sessionID)
	if err != nil {
		return Poll{}, fmt.Errorf("agent stage %q: get session %s: %w", handle.stageID, handle.sessionID, err)
	}
	switch {
	case !exists:
		return Poll{State: PollGone, Reason: fmt.Sprintf("session %s no longer exists", handle.sessionID)}, nil
	case snap.Terminated || snap.Activity == domain.ActivityExited:
		return Poll{State: PollGone, Reason: fmt.Sprintf("session %s ended without signalling", handle.sessionID)}, nil
	case snap.Activity == domain.ActivityIdle,
		snap.Activity == domain.ActivityWaitingInput,
		snap.Activity == domain.ActivityBlocked:
		if !snap.Signalled {
			// Still in the spawn window: the row is seeded idle and no hook has
			// reported yet, so this reading describes the launch, not the agent.
			// Treating it as idle nudges and settles the stage within a couple
			// of ticks, before the agent has read its prompt. A harness that
			// never reports at all is bounded by the stage deadline, which is
			// what deadlines are for (spec section 13.1).
			return Poll{State: PollRunning}, nil
		}
		// Alive but not working, so the missing signal will not arrive on its
		// own. Whether that earns a nudge or a settlement is the reducer's call.
		return Poll{State: PollIdle}, nil
	default:
		// Active, or an activity state this executor does not know about. An
		// unrecognized state is not evidence the agent stopped; the stage's
		// deadline still bounds it.
		return Poll{State: PollRunning}, nil
	}
}

// pollSignal reports a settlement signal at most once. The nudge keeps the
// stage running against the same registry row, so a signal already turned into
// a poll state must not settle the stage a second time.
func (e *AgentExecutor) pollSignal(handle *agentHandle) (Poll, bool) {
	if e.signals == nil {
		return Poll{}, false
	}
	sig, ok := e.signals.LatestSignal(handle.runID, handle.stageID)
	if !ok || !sig.Kind.IsKnown() {
		return Poll{}, false
	}

	handle.mu.Lock()
	defer handle.mu.Unlock()
	if !sig.CreatedAt.After(handle.reportedAt) {
		return Poll{}, false
	}
	handle.reportedAt = sig.CreatedAt

	if sig.Kind == pipeline.SignalFail {
		return Poll{State: PollSignaledFail, Reason: sig.Reason}, true
	}
	return Poll{State: PollSignaledDone}, true
}

// Interrupt stops the agent's work and keeps the session. This is what a
// timed-out stage gets: killing a runaway agent is the point, losing its
// scrollback is not (spec section 7.2).
func (e *AgentExecutor) Interrupt(ctx context.Context, h Handle) error {
	handle, ok := h.(*agentHandle)
	if !ok {
		return fmt.Errorf("agent executor: unexpected handle type %T", h)
	}
	if err := e.sessions.Interrupt(ctx, handle.sessionID); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("agent stage %q: interrupt session %s: %w", handle.stageID, handle.sessionID, err)
	}
	return nil
}

// Cancel kills the session. Run cancellation, not the deadline path.
// Idempotent: the reducer can cancel a stage that has already settled.
func (e *AgentExecutor) Cancel(ctx context.Context, h Handle) error {
	handle, ok := h.(*agentHandle)
	if !ok {
		return fmt.Errorf("agent executor: unexpected handle type %T", h)
	}
	if err := e.sessions.Kill(ctx, handle.sessionID); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("agent stage %q: kill session %s: %w", handle.stageID, handle.sessionID, err)
	}
	return nil
}
