package pi

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps AO-normalized Pi extension events onto activity.
// session-start is metadata-only: it carries Pi's native UUID for restore but
// does not prove a user turn is active.
func DeriveActivityState(event string, _ []byte) (domain.ActivityState, bool) {
	switch event {
	case "user-prompt-submit":
		return domain.ActivityActive, true
	case "stop":
		return domain.ActivityIdle, true
	case "session-end":
		return domain.ActivityExited, true
	default:
		return "", false
	}
}
