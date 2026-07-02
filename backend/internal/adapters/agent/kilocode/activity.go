package kilocode

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Kilo Code plugin hook event onto an AO activity
// state. The bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name the installed plugin shells via
// `ao hooks kilocode <event>` (see kilocodeManagedEvents in hooks.go), not a
// native Kilo event name. The plugin reports:
//   - "session-start"      → a Kilo session was created (turn begins).
//   - "user-prompt-submit" → the user submitted a prompt (turn begins).
//   - "permission-request" → Kilo is asking the user to approve a tool call.
//   - "stop"               → the current turn went idle/finished.
//
// Kilo has no native session/process-end plugin event the adapter maps to
// ActivityExited, so runtime exit still falls back to the lifecycle reaper.
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
