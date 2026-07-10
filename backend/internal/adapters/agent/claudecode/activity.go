package claudecode

import (
	"encoding/json"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// DeriveActivityState maps a Claude Code hook event (and its native stdin
// payload) onto an AO activity state. The bool is false when the event carries
// no activity signal — e.g. SessionStart (metadata only, v1), a Notification
// type we don't track, or a SessionEnd reason that doesn't actually end the AO
// session — in which case the caller reports nothing.
//
// event is the AO hook sub-command name installed in claudeManagedHooks
// ("user-prompt-submit", "stop", "notification", "session-end", ...), NOT the
// native Claude event name. Keeping this beside hooks.go means the events AO
// installs and what they mean live in one place.
func DeriveActivityState(event string, payload []byte) (domain.ActivityState, bool) {
	switch event {
	case "user-prompt-submit":
		return domain.ActivityActive, true
	case "stop":
		// End of a turn (including a user interrupt): the agent is idle but
		// alive (not exited). A following Notification(idle_prompt) also maps to
		// idle, so an interrupted or finished turn reads Idle until the next
		// prompt — only a real permission request flips it to waiting_input.
		return domain.ActivityIdle, true
	case "notification":
		return notificationState(payload)
	case "session-end":
		return sessionEndState(payload)
	default:
		return "", false
	}
}

// notificationState reports waiting_input only when the agent is genuinely
// blocked on the user: a pending tool-permission prompt (permission_prompt).
// idle_prompt means the agent finished its turn and is sitting idle at the
// prompt awaiting the next instruction — that is Idle, not a blocking request,
// so a stop/interrupt reads Idle rather than "Input Needed". Other types
// (auth_success, elicitation_*) carry no activity meaning, as does a malformed
// payload.
func notificationState(payload []byte) (domain.ActivityState, bool) {
	var p struct {
		NotificationType string `json:"notification_type"`
	}
	_ = json.Unmarshal(payload, &p)
	switch p.NotificationType {
	case "permission_prompt":
		return domain.ActivityWaitingInput, true
	case "idle_prompt":
		return domain.ActivityIdle, true
	default:
		return "", false
	}
}

// sessionEndState reports exited for reasons that actually end the session.
// clear/resume keep the same AO session alive (a new native session continues
// in the worktree), so they report nothing. Any other reason — logout,
// prompt_input_exit, bypass_permissions_disabled, other, or an absent/unknown
// reason on a SessionEnd that did fire — is treated as a real exit. SessionEnd
// is not guaranteed on crash/SIGKILL, so the reaper remains the backstop; both
// paths guard on IsTerminated, so whichever lands first wins.
func sessionEndState(payload []byte) (domain.ActivityState, bool) {
	var p struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(payload, &p)
	switch p.Reason {
	case "clear", "resume":
		return "", false
	default:
		return domain.ActivityExited, true
	}
}
