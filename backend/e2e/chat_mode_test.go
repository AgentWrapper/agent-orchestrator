//go:build !windows

package e2e

import (
	"net/http"
	"testing"
	"time"
)

// Scenarios for "the interface you chose is the interface you get".
//
// Mode is decided once, at spawn, from an explicit request or the daemon default,
// and then it is a fact about the session forever. Every other guarantee in chat
// mode rests on that: a session that could change mode would need two controllers,
// and a session whose stored mode disagreed with its controller would strand its
// own history.

func TestChatModeIsChosenAtSpawnAndNeverMoves(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "modes")

	// The daemon owns the default, so a client that says nothing still gets a
	// consistent answer — including `ao spawn` and mobile, which have no UI state.
	d.mustCall("PATCH", "/settings/session-interface", http.StatusOK,
		map[string]any{"defaultSessionMode": "chat"}, nil)

	fromDefault := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "codex",
	})
	if fromDefault.Session.Mode != "chat" {
		t.Fatalf("session spawned under a chat default has mode %q", fromDefault.Session.Mode)
	}

	// An explicit request outranks the default. This is the path `ao spawn --mode`
	// uses, and it must not be silently normalized to the default.
	explicitTUI := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "codex", "mode": "tui",
	})
	if explicitTUI.Session.Mode != "tui" {
		t.Fatalf("explicit --mode tui produced %q", explicitTUI.Session.Mode)
	}

	// Flipping the default must not reach backwards. A session's interface is
	// part of its identity; a preference change that rewrote existing sessions
	// would hand a running agent a controller it was not started with.
	d.mustCall("PATCH", "/settings/session-interface", http.StatusOK,
		map[string]any{"defaultSessionMode": "tui"}, nil)

	var reread struct {
		Session struct{ Mode string } `json:"session"`
	}
	d.mustCall("GET", "/sessions/"+fromDefault.Session.ID, http.StatusOK, nil, &reread)
	if reread.Session.Mode != "chat" {
		t.Fatalf("an existing chat session became %q after the default changed", reread.Session.Mode)
	}

	afterFlip := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "codex",
	})
	if afterFlip.Session.Mode != "tui" {
		t.Fatalf("session spawned after the flip has mode %q, want tui", afterFlip.Session.Mode)
	}

	// A chat session has no terminal to attach to, and the TUI one does. This is
	// the observable difference the whole feature exists to produce.
	chatSnap := d.conversation(fromDefault.Session.ID)
	if chatSnap.Mode != "chat" {
		t.Errorf("conversation reports mode %q", chatSnap.Mode)
	}
	status, body := d.callExpectingError("GET", "/sessions/"+explicitTUI.Session.ID+"/conversation", nil)
	if status == http.StatusOK {
		t.Fatal("a TUI session served a conversation snapshot")
	}
	if body.Code != "SESSION_MODE_MISMATCH" {
		t.Errorf("TUI conversation refusal code = %q, want SESSION_MODE_MISMATCH", body.Code)
	}
}

// A chat request for an agent with no chat driver must fail before anything
// durable exists. The failure mode this guards against is the expensive one: a
// half-created session with a worktree and no way to talk to it, which the user
// then has to find and clean up.
func TestChatSpawnForUnsupportedAgentLeavesNothingBehind(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "unsupported")

	var before struct {
		Sessions []struct{ ID string } `json:"sessions"`
	}
	d.mustCall("GET", "/sessions", http.StatusOK, nil, &before)

	status, body := d.callExpectingError("POST", "/sessions", map[string]any{
		"projectId": project, "kind": "worker", "harness": "claude-code", "mode": "chat",
	})
	if status == http.StatusCreated {
		t.Fatal("chat mode was accepted for an agent with no chat driver")
	}
	if body.Code == "" {
		t.Errorf("refusal carried no error code: %+v", body)
	}

	var after struct {
		Sessions []struct{ ID string } `json:"sessions"`
	}
	d.mustCall("GET", "/sessions", http.StatusOK, nil, &after)
	if len(after.Sessions) != len(before.Sessions) {
		t.Fatalf("a refused chat spawn left %d session rows behind",
			len(after.Sessions)-len(before.Sessions))
	}
}

// The spawn prompt is the user's task brief and must arrive as a real turn: this
// is the moment a chat session becomes useful rather than merely created.
func TestChatSpawnPromptProducesAnAnsweredTurn(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "spawnprompt")

	session := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "codex", "mode": "chat",
		"prompt": "Reply with exactly: SPAWN-OK",
	}).Session.ID

	snap := d.awaitConversation(session, 3*time.Minute, "the spawn prompt to be answered",
		func(s snapshot) bool {
			return len(s.Turns) >= 1 && terminal(s.Turns[0].State) && len(s.Messages) >= 2
		})

	if got := snap.Turns[0].State; got != "completed" {
		t.Errorf("spawn turn state = %q, want completed (err=%q)", got, snap.Turns[0].ErrorMessage)
	}

	first := snap.Messages[0]
	if first.Role != "user" {
		t.Fatalf("first message role = %q, want the user's brief", first.Role)
	}
	// Origin records who AUTHORED a message, not who delivered it. The daemon
	// carries the brief to the provider; that does not make it the daemon's.
	if first.Origin != "human" {
		t.Errorf("spawn prompt origin = %q, want human", first.Origin)
	}
	if !contains(snap.assistantText(), "SPAWN-OK") {
		t.Errorf("agent never answered the brief:\n%s", describe(snap))
	}
}
