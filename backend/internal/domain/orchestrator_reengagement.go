package domain

import "time"

// OrchestratorReengagementState is the durable state of an orchestrator's
// bounded self-continuation loop.
type OrchestratorReengagementState string

const (
	// OrchestratorReengagementActive indicates that automatic re-engagement is eligible to run.
	OrchestratorReengagementActive OrchestratorReengagementState = "active"
	// OrchestratorReengagementCompleted indicates that the orchestrator declared its work complete.
	OrchestratorReengagementCompleted OrchestratorReengagementState = "completed"
	// OrchestratorReengagementExhausted indicates that the automatic retry ceiling was reached.
	OrchestratorReengagementExhausted OrchestratorReengagementState = "exhausted"
)

// OrchestratorReengagement records retry progress independently from derived
// session status.
type OrchestratorReengagement struct {
	SessionID            SessionID
	AttemptCount         int
	NextAttemptAt        time.Time
	LastAttemptAt        time.Time
	ProgressSinceAttempt bool
	AttentionNotified    bool
	State                OrchestratorReengagementState
	CreatedAt            time.Time
	UpdatedAt            time.Time
}
