package qwen

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Qwen Code hook event onto an AO activity state. The
// bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed in qwenManagedHooks
// ("session-start", "user-prompt-submit", "permission-request", "stop"), not
// the native Qwen event name. Qwen Code has no SessionEnd equivalent in the
// adapter yet, so runtime exit still falls back to the reaper.
//
// TODO(qwen): ActivityExited is still runtime-observation-owned. Qwen Code has a
// native SessionEnd hook; if AO installs it, map "session-end" to
// ActivityExited here. Until then, make sure the lifecycle reaper can still mark
// a dead Qwen runtime as exited even when the last hook signal was sticky
// blocked.
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
