package goose

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Goose hook event onto an AO activity state. The
// bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed in gooseManagedHooks
// ("session-start", "user-prompt-submit", "stop", "permission-request"), not
// the native Goose event name.
//
// Goose's native hook surface (as of 2026-05) emits SessionStart /
// UserPromptSubmit / Stop / SessionEnd plus the tool-use events, but has no
// dedicated permission/approval event yet, so AO does not install a
// "permission-request" hook today. The case is kept here so that, if a future
// Goose release adds an approval lifecycle event, mapping it to blocked is
// a one-line hooks.go change with no deriver edit needed.
//
// TODO(goose): ActivityExited is still runtime-observation-owned. Goose has a
// native SessionEnd hook; if AO starts installing it, map it to ActivityExited
// here. Until then, the lifecycle reaper marks a dead Goose runtime as exited.
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
