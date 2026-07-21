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
//   - session-start / user-prompt-submit          → active
//   - pre-tool-use / post-tool-use /
//     post-tool-use-failure                       → active
//   - stop                                        → idle
//   - permission-request                          → waiting_input
//
// The tool-use trio maps to active for adapters that install those callbacks
// (kimi): each tool call refreshes the active signal mid-turn, so a session
// no longer parks on idle after the first Stop while the agent keeps working.
// Adapters that install only the four lifecycle callbacks are unaffected —
// the trio simply never fires for them.
//
// permission-request maps to waiting_input, not blocked. blocked's correlated
// clear in lifecycle needs the pending tool identified by tool_use_id across
// the pre/post payloads (claude-code's wire vocabulary); the sharing adapters
// either lack the trio entirely or, like kimi, identify tool calls as
// tool_call_id, so a blocked state could only fail closed until the turn
// ends. waiting_input still suppresses automated nudges (NeedsInput) while
// leaving user-initiated sends deliverable, and lifecycle keeps it sticky
// against tool-use traffic, so the trio cannot demote a pending approval.
func StandardDeriveActivityState(event string, _ []byte) (domain.ActivityState, bool) {
	switch event {
	case "session-start":
		return domain.ActivityActive, true
	case "user-prompt-submit":
		return domain.ActivityActive, true
	case "pre-tool-use", "post-tool-use", "post-tool-use-failure":
		return domain.ActivityActive, true
	case "stop":
		return domain.ActivityIdle, true
	case "permission-request":
		return domain.ActivityWaitingInput, true
	default:
		return "", false
	}
}
