package cline

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Cline hook event onto an AO activity state. The
// bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed by clineManagedHooks
// ("session-start", "user-prompt-submit", "permission-request", "stop"), not
// the native Cline event name. Cline currently exposes no stable
// session/process-end hook the adapter installs, so runtime exit still falls
// back to the lifecycle reaper.
//
// TODO(cline): ActivityExited is still runtime-observation-owned. If Cline adds
// a stable native session/process-end hook (e.g. session_shutdown via the CLI
// `cline hook` path), map it to ActivityExited here. Until then, ensure the
// reaper can still mark a dead Cline runtime as exited even when the last hook
// signal was sticky blocked.
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
