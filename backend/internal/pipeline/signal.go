package pipeline

import "time"

// SignalKind is how an agent settled its own stage: `ao pipeline done` or
// `ao pipeline fail --reason "..."` (spec section 6.3). The failure channel is
// its own kind rather than a flag, because an agent that concludes the task is
// impossible must route to the failure edge instead of hanging until deadline.
type SignalKind string

// Every signal kind.
const (
	SignalDone SignalKind = "done"
	SignalFail SignalKind = "fail"
)

// IsKnown reports whether k is a defined signal kind.
func (k SignalKind) IsKnown() bool { return k == SignalDone || k == SignalFail }

// StageSignal is one settlement signal, as persisted. Signals are appended,
// never updated: reads take the latest row for a (run, stage), so a second
// signal after a nudge supersedes the first without losing the history.
type StageSignal struct {
	RunID     RunID      `json:"runId"`
	StageID   string     `json:"stageId"`
	Kind      SignalKind `json:"kind"`
	Reason    string     `json:"reason,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}
