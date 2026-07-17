package domain

import (
	"errors"
	"fmt"
	"time"
)

// SpawnState is the machine-readable terminal state of a spawn attempt.
type SpawnState string

const (
	// SpawnStatePreflightFailed means admission failed before identity reservation.
	SpawnStatePreflightFailed SpawnState = "preflight_failed"
	// SpawnStateLaunchFailed means worktree or runtime launch failed.
	SpawnStateLaunchFailed SpawnState = "launch_failed"
	// SpawnStateCommitFailed means launch succeeded but durable verification failed.
	SpawnStateCommitFailed SpawnState = "commit_failed"
	// SpawnStateRolledBack means all partial spawn state was removed.
	SpawnStateRolledBack SpawnState = "rolled_back"
	// SpawnStateSpawned means the worker passed the durable commit point.
	SpawnStateSpawned SpawnState = "spawned"
)

// SpawnPhase identifies the transaction phase that produced an outcome.
type SpawnPhase string

const (
	// SpawnPhasePreflight validates prerequisites without side effects.
	SpawnPhasePreflight SpawnPhase = "preflight"
	// SpawnPhaseLaunch provisions the isolated workspace and runtime.
	SpawnPhaseLaunch SpawnPhase = "launch"
	// SpawnPhaseCommit verifies and persists the worker identity atomically.
	SpawnPhaseCommit SpawnPhase = "commit"
)

// SpawnPreflight is the machine-readable, side-effect-free launch admission result.
type SpawnPreflight struct {
	OK              bool            `json:"ok"`
	State           SpawnState      `json:"state"`
	Phase           SpawnPhase      `json:"phase"`
	LauncherPath    string          `json:"launcherPath,omitempty"`
	AgentBinaryPath string          `json:"agentBinaryPath,omitempty"`
	Runtime         string          `json:"runtime"`
	CapabilityClass CapabilityClass `json:"capabilityClass"`
	ProfileHash     string          `json:"profileHash"`
}

// SpawnOutcome describes a committed or failed transactional spawn.
type SpawnOutcome struct {
	State         SpawnState `json:"state"`
	Phase         SpawnPhase `json:"phase"`
	SessionID     SessionID  `json:"sessionId,omitempty"`
	Generation    string     `json:"generation,omitempty"`
	Worktree      string     `json:"worktree,omitempty"`
	ProfileHash   string     `json:"profileHash,omitempty"`
	RolledBack    bool       `json:"rolledBack"`
	RollbackState SpawnState `json:"rollbackState,omitempty"`
}

// SpawnReservation allocates identity without creating a visible session row.
type SpawnReservation struct {
	RequestID  string
	Generation string
	SessionID  SessionID
	ProjectID  ProjectID
	Num        int64
	CreatedAt  time.Time
}

// SpawnError carries the failed phase and rollback result through API errors.
type SpawnError struct {
	Outcome SpawnOutcome
	Cause   error
}

func (e *SpawnError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("spawn %s (%s): %v", e.Outcome.Phase, e.Outcome.State, e.Cause)
}

// Unwrap exposes the underlying typed failure.
func (e *SpawnError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// NewSpawnError constructs a structured transactional failure.
func NewSpawnError(state SpawnState, phase SpawnPhase, cause error) *SpawnError {
	if cause == nil {
		cause = errors.New("spawn failed")
	}
	return &SpawnError{Outcome: SpawnOutcome{State: state, Phase: phase}, Cause: cause}
}
