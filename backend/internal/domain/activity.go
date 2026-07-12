package domain

import "time"

// ActivityState is how busy the agent is, reported via the agent's CLI hook
// callbacks (see docs/agent/README.md), not inferred from transcript/JSONL
type ActivityState string

// Activity states. WaitingInput is sticky (see IsSticky).
const (
	ActivityActive       ActivityState = "active"
	ActivityIdle         ActivityState = "idle"
	ActivityWaitingInput ActivityState = "waiting_input"
	ActivityExited       ActivityState = "exited"
)

// ActivitySignalOnly is a wire-only marker, never a real persisted
// Activity.State: it lets a hook that fires on every launch (fresh spawn and
// resume alike), but carries no activity reading of its own, prove the hook
// pipeline is reachable without asserting how busy the agent is. Lifecycle
// intercepts it before it ever reaches Activity.State — see
// Manager.ApplyActivitySignal.
const ActivitySignalOnly ActivityState = "signal_only"

// IsSticky reports whether an activity state must NOT be aged/demoted by the
// passage of time (a paused agent is still paused until a new signal says so).
func (a ActivityState) IsSticky() bool {
	return a == ActivityWaitingInput
}

// Activity captures the persisted activity reading: the state and when it was
// last observed.
type Activity struct {
	State          ActivityState `json:"state"`
	LastActivityAt time.Time     `json:"lastActivityAt"`
}
