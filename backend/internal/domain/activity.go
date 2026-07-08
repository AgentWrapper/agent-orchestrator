package domain

import "time"

// ActivityState is how busy the agent is, reported via the agent's CLI hook
// callbacks (see docs/agent/README.md), not inferred from transcript/JSONL
type ActivityState string

// Activity states. WaitingInput is sticky (see IsSticky).
const (
	ActivityActive ActivityState = "active"
	ActivityIdle   ActivityState = "idle"
	// ActivityWaitingInput means the agent is genuinely blocked on a
	// human/orchestrator decision (e.g. a tool-permission prompt) — not merely
	// idle at the end of an ordinary turn.
	ActivityWaitingInput ActivityState = "waiting_input"
	ActivityExited       ActivityState = "exited"
)

// IsSticky reports whether an activity state must NOT be aged/demoted by the
// passage of time (an agent genuinely blocked on a decision is still blocked
// until a new signal says otherwise).
func (a ActivityState) IsSticky() bool {
	return a == ActivityWaitingInput
}

// Activity captures the persisted activity reading: the state and when it was
// last observed.
type Activity struct {
	State          ActivityState `json:"state"`
	LastActivityAt time.Time     `json:"lastActivityAt"`
}
