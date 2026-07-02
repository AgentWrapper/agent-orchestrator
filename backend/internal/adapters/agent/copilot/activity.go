package copilot

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// DeriveActivityState maps a Copilot CLI hook event onto an AO activity state.
// The bool is false when the event carries no activity signal.
//
// event is the AO hook sub-command name installed in copilotManagedHooks
// ("session-start", "user-prompt-submit", "permission-request", "stop"), NOT the
// native Copilot event name. Keeping this beside hooks.go means the events AO
// installs and what they mean live in one place.
//
// Copilot CLI documents that prompt-style hooks (userPromptSubmitted) do NOT
// fire in non-interactive `-p` mode, while preToolUse fires before every tool
// invocation (including ones that would prompt the user for approval) and is
// the most reliable signal in CLI pipe mode (-p). AO still installs every event
// so interactive resume and future modes report activity; the
// permission-request → blocked mapping (driven by preToolUse) is the one
// that always fires under AO's headless launch.
//
// TODO(copilot): ActivityExited is still runtime-observation-owned. If Copilot's
// sessionEnd/agentStop hook proves reliable in `-p` mode, map a real
// session-end here. Until then, the lifecycle reaper marks a dead Copilot
// runtime exited even when the last hook signal was sticky blocked.
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
