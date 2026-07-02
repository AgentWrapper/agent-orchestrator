package kiro

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Kiro hook event onto an AO activity state. The
// bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed in kiroManagedHooks
// ("session-start", "user-prompt-submit", "permission-request", "stop"), not
// the native Kiro event name (agentSpawn/userPromptSubmit/preToolUse/stop).
// Kiro currently has no session/process-end hook in the adapter, so runtime
// exit still falls back to the lifecycle reaper.
//
// TODO(kiro): ActivityExited is still runtime-observation-owned. If Kiro adds a
// native session/process-end hook, map that hook to ActivityExited here. Until
// then, make sure the lifecycle reaper can still mark a dead Kiro runtime as
// exited even when the last hook signal was sticky blocked.
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
