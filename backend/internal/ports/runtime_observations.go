package ports

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProbeResult is a single liveness reading. "failed" means the probe errored
// or timed out and is never treated as a death conclusion.
type ProbeResult string

// Probe readings. Alive/Dead are conclusions; Failed is ignored by lifecycle
// because it is not a reliable death decision.
const (
	ProbeAlive  ProbeResult = "alive"
	ProbeDead   ProbeResult = "dead"
	ProbeFailed ProbeResult = "failed"
)

// RuntimeFacts is what the reaper reports each probe of a session runtime.
type RuntimeFacts struct {
	ObservedAt time.Time
	Probe      ProbeResult
}

// ActivitySignal is pushed by the agent hooks. Only a Valid signal is
// authoritative; a stale/absent one is ignored rather than read as idleness.
//
// Event/ToolName/ToolUseID are optional correlation facts: the AO hook
// sub-command that produced the state and, for tool-use hooks, the native
// tool call it concerns. Lifecycle uses them to clear a stale blocked state
// only when the specific approved tool finishes. A signal without an Event
// (old CLIs, adapters with no tool identity) keeps plain last-writer-wins
// state semantics.
type ActivitySignal struct {
	Valid     bool
	State     domain.ActivityState
	Timestamp time.Time
	Event     string
	ToolName  string
	ToolUseID string
}
