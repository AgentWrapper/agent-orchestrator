package domain

import "time"

// WorkerIdleEvent is a durable, project-scoped coordination event recorded when
// a worker completes a turn (active -> idle). It is delivered to the project
// orchestrator at least once; delivery timing is decoupled from creation so a
// completion is never lost when no safe orchestrator is available yet.
type WorkerIdleEvent struct {
	ID           string
	ProjectID    ProjectID
	WorkerID     SessionID
	TransitionAt time.Time
	CreatedAt    time.Time
}

// HarnessSteersActiveTurn reports whether submitting input to a harness during
// an active turn steers the current run rather than being dropped or answering
// a dialog. Only harnesses known to be safe opt in; every unknown harness
// defaults to false so an active orchestrator is left alone unless proven safe.
func HarnessSteersActiveTurn(h AgentHarness) bool {
	return h == HarnessCodex
}
