package lifecycle

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const defaultRecentActivityWindow = 60 * time.Second

// deadProbeConfirmations is how many consecutive ProbeDead readings the
// reducer requires before it terminates a session. Hook delivery is
// best-effort, so recorded activity can be stale on a genuinely live session;
// a single dead sample landing in that window must not kill it irreversibly
// (#2501). At the reaper's 5s cadence three readings confirm death within
// ~15s — and the streak accrues while recent activity still vetoes
// termination, so a genuinely dead runtime is typically terminated the moment
// its activity goes stale, with no added latency.
const deadProbeConfirmations = 3

func hasRecentActivity(a domain.Activity, now time.Time, window time.Duration) bool {
	switch {
	case a.State == domain.ActivityExited:
		return false
	case a.State.IsSticky():
		return true
	case a.LastActivityAt.IsZero():
		return false
	default:
		return now.Sub(a.LastActivityAt) <= window
	}
}

func runtimeClearlyDead(f ports.RuntimeFacts, activity domain.Activity, now time.Time, window time.Duration) bool {
	observedAt := timeOr(f.ObservedAt, now)
	return f.Probe == ports.ProbeDead && !hasRecentActivity(activity, observedAt, window)
}

func timeOr(t, fallback time.Time) time.Time {
	if t.IsZero() {
		return fallback
	}
	return t
}
