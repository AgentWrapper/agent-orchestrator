package executors

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// SpawnRequest is the narrow spawn payload the agent executor hands the session
// manager. It carries only what a pipeline stage needs; the concrete adapter
// (wired by T5) maps it onto ports.SpawnConfig.
type SpawnRequest struct {
	ProjectID string
	IssueID   string
	// Prompt is the fully-assembled stage prompt injected at spawn time.
	Prompt string
	// Harness is the agent plugin the stage requested (stage.executor.plugin).
	// Empty lets the project default pick the harness.
	Harness string
	// Branch is the PR source branch to check the spawned session out onto, so
	// review sessions see the PR diff and can push to it. Empty spawns a fresh
	// worktree off the project default branch.
	Branch string
	// StageRunID is the run-unique id of the stage attempt. The spawn adapter uses
	// it to mint a collision-free fallback branch name when Branch is already
	// checked out in another worktree.
	StageRunID string
}

// SpawnedSession is what the session manager returns for a fresh spawn.
type SpawnedSession struct {
	SessionID     string
	WorkspacePath string
}

// SessionSnapshot is the subset of session state the agent executor polls: is
// the agent idle, and has the session gone terminal (killed/exited) without
// producing findings.
type SessionSnapshot struct {
	// Activity is the agent's reported activity state (domain.ActivityState
	// value, e.g. "idle", "active", "exited").
	Activity string
	// Terminated reports whether the session row is terminated.
	Terminated bool
}

// SessionSpawner is the session-manager seam the agent executor needs: spawn a
// fresh visible session, snapshot its state, and kill it. Mirrors the DI style
// of internal/review's Launcher so the concrete Manager never enters this
// package's core logic.
type SessionSpawner interface {
	Spawn(ctx context.Context, req SpawnRequest) (SpawnedSession, error)
	// Get returns a snapshot and whether the session still exists.
	Get(ctx context.Context, sessionID string) (SessionSnapshot, bool, error)
	// Kill tears the session down. Idempotent; a missing session is not an error.
	Kill(ctx context.Context, sessionID string) error
}

// agentHandle is the running-stage token for an agent stage. final is non-nil
// when the stage short-circuited before spawn (the fork gate); Poll then returns
// it immediately and no session was ever created.
type agentHandle struct {
	stageIdentity
	sessionID     string
	workspacePath string
	final         *Outcome
}

// AgentExecutor bridges a pipeline stage to a real, visible AO session: spawn a
// fresh session with the stage prompt, wait for the agent to go idle AND drop
// its findings file, harvest the findings, then kill the session. It touches
// neither the reducer nor the store; the engine threads outcomes onward.
type AgentExecutor struct {
	sessions SessionSpawner
}

// NewAgentExecutor builds an agent executor over the given session seam.
func NewAgentExecutor(sessions SessionSpawner) *AgentExecutor {
	return &AgentExecutor{sessions: sessions}
}

var _ StageExecutor = (*AgentExecutor)(nil)

// Start spawns the stage's session and returns a handle. It errors (mapped by
// the engine to STAGE_FAILED) when the stage is not an agent stage, the spawn
// fails, or the spawned session has no workspace to harvest findings from.
func (e *AgentExecutor) Start(ctx context.Context, in StartInput) (Handle, error) {
	if in.Stage.Executor.Kind != pipeline.ExecutorAgent {
		return nil, fmt.Errorf("agent executor cannot start stage %q with executor.kind=%s", in.Stage.Name, in.Stage.Executor.Kind)
	}

	id := stageIdentity{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}

	// Fork-PR gate, BEFORE spawn, via the shared helper so agent stages honor the
	// same trust boundary as command stages. Resolved from the run context's
	// tri-state (a PR run always carries it; a manual/no-PR run resolves to
	// ForkNo and flows normally). No session is spawned when the gate blocks.
	fork, prNumber := forkFromContext(in.Context)
	if skip, gated := forkGateDecision(fork, prNumber, in.Stage.Name, in.AllowForkPRs); gated {
		return &agentHandle{stageIdentity: id, final: &skip}, nil
	}

	prompt := buildStagePrompt(in.PipelineName, in.Stage, in.LoopRound, in.Context, in.UpstreamFindings)
	session, err := e.sessions.Spawn(ctx, SpawnRequest{
		ProjectID:  in.ProjectID,
		IssueID:    in.IssueID,
		Prompt:     prompt,
		Harness:    in.Stage.Executor.Plugin,
		Branch:     in.Context.SourceBranch,
		StageRunID: string(in.StageRunID),
	})
	if err != nil {
		return nil, fmt.Errorf("agent executor: spawn session for stage %q: %w", in.Stage.Name, err)
	}
	if session.WorkspacePath == "" {
		// Belt-and-suspenders: without a workspace there is no known path to
		// harvest findings from. Kill the orphan and fail the start.
		_ = e.sessions.Kill(ctx, session.SessionID)
		return nil, fmt.Errorf("agent executor: session %s for stage %q has no workspace; cannot harvest findings", session.SessionID, in.Stage.Name)
	}

	return &agentHandle{
		stageIdentity: id,
		sessionID:     session.SessionID,
		workspacePath: session.WorkspacePath,
	}, nil
}

// Poll reports OutcomeRunning until the session is idle AND the findings file
// exists, then harvests findings, kills the session, and returns
// OutcomeCompleted. A vanished or terminal-without-findings session, or an
// unparseable findings file, yields OutcomeFailed. On a bad findings file the
// session is left alive for human inspection.
func (e *AgentExecutor) Poll(ctx context.Context, h Handle) (Outcome, error) {
	handle, ok := h.(*agentHandle)
	if !ok {
		return Outcome{}, fmt.Errorf("agent executor: unexpected handle type %T", h)
	}
	if handle.final != nil {
		// Fork-gated (or otherwise pre-decided) stage: no session was spawned.
		return *handle.final, nil
	}

	snap, exists, err := e.sessions.Get(ctx, handle.sessionID)
	if err != nil {
		return Outcome{}, fmt.Errorf("agent executor: get session %s: %w", handle.sessionID, err)
	}
	if !exists {
		// The session vanished between polls: fail rather than spin forever
		// waiting for an idle signal that will never come.
		return Outcome{
			Status:       OutcomeFailed,
			SessionID:    handle.sessionID,
			ErrorMessage: fmt.Sprintf("stage %q session %s no longer exists", handle.stageName, handle.sessionID),
		}, nil
	}
	if snap.Terminated || snap.Activity == "exited" {
		return Outcome{
			Status:       OutcomeFailed,
			SessionID:    handle.sessionID,
			ErrorMessage: fmt.Sprintf("stage %q session %s terminated without findings (activity=%s)", handle.stageName, handle.sessionID, snap.Activity),
		}, nil
	}

	findingsPath := filepath.Join(handle.workspacePath, stageFindingsRelativePath)
	if snap.Activity != "idle" || !fileExists(findingsPath) {
		return Outcome{Status: OutcomeRunning}, nil
	}

	result, err := parseFindingsFile(findingsPath)
	if err != nil {
		// Leave the session up so a human can inspect the bad findings file.
		return Outcome{
			Status:       OutcomeFailed,
			SessionID:    handle.sessionID,
			ErrorMessage: fmt.Sprintf("stage %q produced unparseable findings at %s: %v", handle.stageName, findingsPath, err),
		}, nil
	}

	_ = e.sessions.Kill(ctx, handle.sessionID)

	outcome := Outcome{Status: OutcomeCompleted, SessionID: handle.sessionID, Artifacts: result.artifacts, StatusChanges: result.statusChanges}
	if result.truncated {
		outcome.Observations = []Observation{{
			Name: "pipeline.findings.truncated",
			Data: map[string]any{
				"runId":        string(handle.runID),
				"stageRunId":   string(handle.stageRunID),
				"stageName":    handle.stageName,
				"findingsPath": findingsPath,
				"capBytes":     findingsFileSizeCapBytes,
				"bytesRead":    result.bytesRead,
			},
			Note: fmt.Sprintf("findings file exceeded %d bytes and was truncated; some findings may be missing", findingsFileSizeCapBytes),
		}}
	}
	return outcome, nil
}

// Cancel kills the underlying session early. Idempotent.
func (e *AgentExecutor) Cancel(ctx context.Context, h Handle) error {
	handle, ok := h.(*agentHandle)
	if !ok {
		return fmt.Errorf("agent executor: unexpected handle type %T", h)
	}
	if handle.final != nil || handle.sessionID == "" {
		// Fork-gated stage: no session was ever spawned, nothing to tear down.
		return nil
	}
	if err := e.sessions.Kill(ctx, handle.sessionID); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("agent executor: kill session %s: %w", handle.sessionID, err)
	}
	return nil
}
