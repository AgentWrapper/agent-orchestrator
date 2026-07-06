// Package activitystate holds the standard mapping from an AO hook sub-command
// name onto an activity state. Most adapters install the same
// session-start/user-prompt-submit/stop/permission-request callbacks and derive
// activity identically from the event name alone; they share this deriver rather
// than each carrying a copy. Adapters that inspect the hook payload for finer
// grained state (claude-code, codex, droid) keep their own deriver.
package activitystate

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// StandardDeriveActivityState maps a hook sub-command name onto an AO activity
// state. The bool is false when the event carries no activity signal. The
// payload is ignored: this is the name-only mapping shared by adapters whose
// hooks report activity purely through which callback fired.
//
//   - session-start / user-prompt-submit → active
//   - stop                               → idle
//   - permission-request                 → blocked
//
// permission-request maps to the sticky blocked (not waiting_input): these
// adapters fire it only for a pending permission/approval decision, where a
// stray automated Enter could answer the dialog on the user's behalf, so
// automated senders must never inject input. See domain.ActivityState.NeedsInput.
func StandardDeriveActivityState(event string, _ []byte) (domain.ActivityState, bool) {
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
