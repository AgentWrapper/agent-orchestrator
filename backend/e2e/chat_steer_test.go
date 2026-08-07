//go:build !windows

package e2e

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// Scenarios for steering: guidance delivered into a turn that is already running.
//
// The claim worth testing end to end is not "the route returned 202" but the reason
// steering exists at all. Interrupt-and-resend throws the turn away — its context,
// its reasoning, the command it has running — and pays for the work again. A steer
// keeps the turn: same id, same in-flight work, and the agent decides what to
// abandon. Only a real provider can demonstrate that, which is why this is an
// end-to-end scenario and not a unit test.
//
// Measured against codex-cli 0.146.0 while writing it: the steered turn kept its id,
// emitted one turn/started and one turn/completed, settled `completed` rather than
// `interrupted`, and the agent aborted the shell loop it was running on its own.

type steerAccepted struct {
	ProviderTurnID string `json:"providerTurnId"`
	ActivityID     string `json:"activityId"`
}

type steerDetail struct {
	Event           string `json:"event"`
	Text            string `json:"text"`
	Origin          string `json:"origin"`
	ClientMessageID string `json:"clientMessageId"`
}

// steerMarkers reads the steer entries out of a timeline the way the renderer must:
// by the discriminator in the detail payload. `system` is a general bucket, so the
// activity kind alone does not identify one.
func steerMarkers(s snapshot) []activity {
	var found []activity
	for _, a := range s.Activities {
		if a.Kind != "system" || len(a.DetailJSON) == 0 {
			continue
		}
		var detail steerDetail
		if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
			continue
		}
		if detail.Event == "steer" {
			found = append(found, a)
		}
	}
	return found
}

func steerDetailOf(t *testing.T, a activity) steerDetail {
	t.Helper()
	var detail steerDetail
	if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
		t.Fatalf("steer detail does not decode: %v: %s", err, a.DetailJSON)
	}
	return detail
}

// runningTurn returns the turn the provider is working on right now.
func runningTurn(s snapshot) (turn, bool) {
	for _, t := range s.Turns {
		if t.State == "running" {
			return t, true
		}
	}
	return turn{}, false
}

func TestChatSteerKeepsTheTurnAndItsWork(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "steer")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	// Long enough to still be working when the steer lands, and visibly abandoned if
	// the agent takes the correction.
	send(t, d, session,
		"Run this exact shell command and then report its output verbatim: "+
			"for i in 1 2 3 4 5 6 7 8 9 10; do echo tick-$i; sleep 3; done", "steer-turn")

	// Wait for the turn to be genuinely under way. The provider refuses a steer for a
	// turn it has accepted but not yet announced, and the daemon rides that gap out —
	// but starting from a turn that is visibly running keeps the scenario about
	// steering rather than about the race.
	before := d.awaitConversation(session, 2*time.Minute, "the turn to be running",
		func(s snapshot) bool {
			_, running := runningTurn(s)
			return running
		})
	running, _ := runningTurn(before)
	turnsBefore := len(before.Turns)

	var accepted steerAccepted
	d.mustCall("POST", "/sessions/"+session+"/conversation/steer", http.StatusAccepted,
		map[string]any{
			"text": "Change of plan: abandon that loop immediately and reply with the " +
				"single word STEERED and nothing else.",
			"clientMessageId": "steer-1",
		}, &accepted)

	// The guidance joined the turn the user was already watching. A steer that opened
	// a turn of its own would attribute their correction to work they never saw.
	if accepted.ProviderTurnID != running.ProviderTurnID {
		t.Errorf("steer landed on turn %q, want the running turn %q",
			accepted.ProviderTurnID, running.ProviderTurnID)
	}
	if accepted.ActivityID == "" {
		t.Error("no activity id reported; a client cannot reconcile its own bubble")
	}

	snap := d.awaitConversation(session, 4*time.Minute, "the steered turn to finish",
		func(s snapshot) bool {
			last, ok := s.turnByID(running.ID)
			return ok && terminal(last.State)
		})

	settled, _ := snap.turnByID(running.ID)
	// The whole point. Interrupt-and-resend produces an interrupted turn and a second
	// one; steering produces neither.
	if settled.State != "completed" {
		t.Errorf("steered turn state = %q, want completed:\n%s", settled.State, describe(snap))
	}
	if len(snap.Turns) != turnsBefore {
		t.Errorf("steering added %d turn(s); guidance must join the running turn, not open one:\n%s",
			len(snap.Turns)-turnsBefore, describe(snap))
	}
	if !contains(snap.assistantText(), "STEERED") {
		t.Errorf("the agent never acted on the guidance:\n%s", describe(snap))
	}

	// And the user can see that it landed. Without a row, a conversation that changed
	// direction mid-turn has no visible cause.
	markers := steerMarkers(snap)
	if len(markers) != 1 {
		t.Fatalf("got %d steer entries for one steer:\n%s", len(markers), describe(snap))
	}
	if markers[0].TurnID != running.ID {
		t.Errorf("steer recorded on turn %q, want %q", markers[0].TurnID, running.ID)
	}
	detail := steerDetailOf(t, markers[0])
	if !contains(detail.Text, "abandon that loop") {
		t.Errorf("recorded steer text = %q", detail.Text)
	}
	if detail.Origin != "human" {
		t.Errorf("recorded origin = %q, want human", detail.Origin)
	}
	if detail.ClientMessageID != "steer-1" {
		t.Errorf("recorded client message id = %q, want steer-1", detail.ClientMessageID)
	}

	// The session still works afterwards. A steer that left the conversation unable to
	// take another turn would have solved nothing.
	send(t, d, session, "Reply with exactly: STILLHERE", "steer-after")
	after := d.awaitConversation(session, 3*time.Minute, "a turn after the steer",
		func(s snapshot) bool { return contains(s.assistantText(), "STILLHERE") })
	for _, turn := range after.Turns {
		if turn.State == "failed" {
			t.Errorf("a turn failed around the steer (%q):\n%s", turn.ErrorMessage, describe(after))
		}
	}
}

// Steering an idle conversation is an ordinary thing to do by accident — the turn
// finished while the user was typing — so it must be a typed refusal that tells them
// to send it as a message, not a server fault and not a silent new turn.
func TestChatSteerWithNoTurnInFlightIsRefusedAndChangesNothing(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "steeridle")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	before := d.conversation(session)

	status, body := d.callExpectingError("POST", "/sessions/"+session+"/conversation/steer",
		map[string]any{"text": "guidance with nowhere to go"})
	if status >= 500 {
		t.Fatalf("steering an idle conversation returned %d (%+v); this is a refusal, not a fault",
			status, body)
	}
	if status != http.StatusConflict || body.Code != "CHAT_NO_ACTIVE_TURN" {
		t.Errorf("status/code = %d/%q, want 409/CHAT_NO_ACTIVE_TURN", status, body.Code)
	}

	after := d.conversation(session)
	if len(after.Turns) != len(before.Turns) {
		t.Errorf("a refused steer started a turn: %d -> %d", len(before.Turns), len(after.Turns))
	}
	if got := len(steerMarkers(after)); got != 0 {
		t.Errorf("a refused steer left %d entries on the timeline", got)
	}
}

// The route dispatches from the session's persisted mode, like every other chat
// command, so a TUI session cannot reach it by calling the URL directly.
func TestChatSteerIsRefusedForATerminalSession(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "steertui")

	tui := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "codex", "mode": "tui",
		"prompt": "echo hello",
	})

	status, body := d.callExpectingError("POST",
		"/sessions/"+tui.Session.ID+"/conversation/steer",
		map[string]any{"text": "guidance"})
	if status != http.StatusConflict || body.Code != "SESSION_MODE_MISMATCH" {
		t.Errorf("status/code = %d/%q, want 409/SESSION_MODE_MISMATCH", status, body.Code)
	}
}
