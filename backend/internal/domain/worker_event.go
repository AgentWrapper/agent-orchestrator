package domain

import "time"

// WorkerIdleEvent is a durable, project-scoped coordination event recorded when
// a worker completes a turn (active -> idle). Delivery timing is decoupled from
// creation so a completion is never lost while no safe orchestrator exists.
//
// Delivery is AT-LEAST-ONCE, not exactly-once: the event is marked delivered
// only after the guard reports a pane write was attempted, so a crash between
// the write and that mark redelivers it. A duplicate nudge is preferred to a
// silently lost completion.
//
// Lifetime is bound to the source worker: the event's only instruction is to
// inspect that worker, so if the worker row is deleted the event is obsolete
// and is removed with it (worker_id ON DELETE CASCADE, migration 0025).
type WorkerIdleEvent struct {
	ID           string
	ProjectID    ProjectID
	WorkerID     SessionID
	TransitionAt time.Time
	CreatedAt    time.Time
}
