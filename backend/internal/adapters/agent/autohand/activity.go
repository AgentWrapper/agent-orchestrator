package autohand

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps an Autohand hook event onto an AO activity state. The
// bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed in autohandManagedHooks
// ("session-start", "user-prompt-submit", "permission-request", "stop"), routed
// from Autohand's native lifecycle events. Autohand has no SessionEnd/process-
// exit hook wired into the adapter, so runtime exit still falls back to the
// lifecycle reaper.
func DeriveActivityState(event string, _ []byte) (domain.ActivityState, bool) {
	switch event {
	case "session-start":
		return domain.ActivityActive, true
	case "user-prompt-submit":
		return domain.ActivityActive, true
	case "stop":
		return domain.ActivityIdle, true
	case "permission-request":
		return domain.ActivityBlocked, true
	default:
		return "", false
	}
}
