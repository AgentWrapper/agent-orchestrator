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
		// End of a turn: the agent is idle but alive (not exited). A following
		// Notification(idle_prompt) upgrades this to the sticky waiting_input.
		return domain.ActivityIdle, true
	case "notification":
		return notificationState(payload)
	case "session-end":
		return sessionEndState(payload)
	default:
		return "", false
	}
}

// notificationState splits the notification types that mean "the agent is
// paused on the user" by what unblocks them: idle_prompt is an empty prompt
// awaiting the next instruction (waiting_input — safe for automation to
// message), while permission_prompt is a pending tool-approval dialog (blocked
// — a stray Enter could answer it, so automated senders must not inject
// input). Other types (auth_success, elicitation_*) carry no activity meaning,
// as does a malformed payload.
func notificationState(payload []byte) (domain.ActivityState, bool) {
	var p struct {
		NotificationType string `json:"notification_type"`
	}
	_ = json.Unmarshal(payload, &p)
	switch p.NotificationType {
	case "idle_prompt":
		return domain.ActivityWaitingInput, true
	case "permission_prompt":
		return domain.ActivityBlocked, true
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
