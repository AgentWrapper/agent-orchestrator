package cursor

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Cursor hook event onto an AO activity state. The
// bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed in cursorManagedHooks
// ("session-start", "user-prompt-submit", "stop", "permission-request"), not
// the native Cursor event name. Cursor currently has no SessionEnd/Notification
// equivalent in the adapter, so runtime exit still falls back to the reaper.
//
// TODO(cursor): ActivityExited is still runtime-observation-owned. If Cursor
// adds a native session/process-end hook, map that hook to ActivityExited here.
// Until then, make sure the lifecycle reaper can still mark a dead Cursor
// runtime as exited even when the last hook signal was sticky blocked.
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
