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
type ActivitySignal struct {
	Valid     bool
	State     domain.ActivityState
	Harness   domain.AgentHarness
	Timestamp time.Time
}
