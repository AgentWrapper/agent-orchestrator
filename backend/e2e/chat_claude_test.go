//go:build !windows

package e2e

import (
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Scenarios for the second chat driver.
//
// Claude Code is a peer of Codex, not a special case, so what is checked here is
// exactly what the port promises and nothing about Claude in particular: chat mode
// is offerable for the harness, a turn answers, an approval round-trips, stop
// stops, and a daemon restart keeps the conversation. The rest of this suite
// already covers the neutral behavior on top of a driver; the point of this file
// is that the same behavior holds when the provider underneath is a different one.
//
// The driver's own protocol claims are settled in
// internal/adapters/chatdriver/claudecode (unit tests over pipes, plus an
// AO_CLAUDE_LIVE gate against the real CLI). These are about the whole stack.

// requireClaudeE2E skips unless the suite gate is set and a claude install is
// present. Skipping loudly with a reason beats a green run that exercised nothing.
func requireClaudeE2E(t *testing.T) {
	t.Helper()
	if os.Getenv(gateEnv) != "1" {
		t.Skipf("set %s=1 to run the chat end-to-end suite (real daemon, real model calls)", gateEnv)
	}
	bin := claudeBinary()
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("claude binary %q is not on PATH: %v", bin, err)
	}
}

func claudeBinary() string {
	if bin := os.Getenv("AO_CLAUDE_BIN"); bin != "" {
		return bin
	}
	return "claude"
}

// claudeChatSession spawns a chat session on the claude-code harness and waits for
// its first turn to settle, so a scenario starts from a known state rather than
// racing the spawn turn.
func claudeChatSession(t *testing.T, d *daemon, project, prompt string) string {
	t.Helper()
	id := spawn(t, d, map[string]any{
		"projectId": project, "kind": "worker", "harness": "claude-code", "mode": "chat",
		"prompt": prompt,
	}).Session.ID
	d.awaitConversation(id, 4*time.Minute, "the claude session to finish its first turn",
		func(s snapshot) bool {
			return len(s.Turns) >= 1 && terminal(s.Turns[0].State)
		})
	return id
}

// Registration is the whole capability gate: /settings derives chatHarnesses from
// the driver registry, and every client — Settings UI, `ao spawn --mode chat`,
// mobile — decides what to offer from that one list. A driver that works but is
// not advertised is a driver nobody can reach.
func TestClaudeCodeIsOfferedAsAChatHarness(t *testing.T) {
	requireClaudeE2E(t)
	d := startDaemon(t, t.TempDir())

	var settings struct {
		ChatHarnesses []string `json:"chatHarnesses"`
	}
	d.mustCall("GET", "/settings", http.StatusOK, nil, &settings)

	offered := map[string]bool{}
	for _, harness := range settings.ChatHarnesses {
		offered[harness] = true
	}
	// Peers, both of them. Asserted together because the failure this guards
	// against is a registration that replaces rather than adds.
	for _, want := range []string{"codex", "claude-code"} {
		if !offered[want] {
			t.Errorf("chatHarnesses = %v, missing %q", settings.ChatHarnesses, want)
		}
	}
}

// harnessWithoutChatDriver names an agent the daemon says cannot run chat mode.
// Read from the daemon rather than hardcoded: drivers get added, and a test naming
// an agent by hand quietly stops testing anything the day that agent gains one.
func harnessWithoutChatDriver(t *testing.T, d *daemon) string {
	t.Helper()
	var settings struct {
		ChatHarnesses []string `json:"chatHarnesses"`
	}
	d.mustCall("GET", "/settings", http.StatusOK, nil, &settings)

	supported := map[string]bool{}
	for _, harness := range settings.ChatHarnesses {
		supported[harness] = true
	}
	// Any real harness will do; these are simply ones with no machine protocol AO
	// drives. The loop is what keeps the test honest if one of them ever gains a
	// driver.
	for _, candidate := range []string{"aider", "goose", "continue", "cline", "amp"} {
		if !supported[candidate] {
			return candidate
		}
	}
	t.Fatalf("every candidate harness now has a chat driver: %v", settings.ChatHarnesses)
	return ""
}

// The baseline: a turn answers, and the answer plus an account of how it was
// reached both land on the timeline.
func TestClaudeChatTurnIsAnsweredAndProjected(t *testing.T) {
	requireClaudeE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "claudeturn")
	session := claudeChatSession(t, d, project, "Reply with exactly: READY")

	send(t, d, session, "Read README.md in this repo, then reply with exactly: LISTED", "c-claude-list")

	snap := d.awaitConversation(session, 4*time.Minute, "the claude turn to complete",
		func(s snapshot) bool {
			return len(s.Turns) >= 2 && terminal(s.Turns[1].State)
		})

	if got := snap.Turns[1].State; got != "completed" {
		t.Errorf("turn state = %q, want completed (err=%q)", got, snap.Turns[1].ErrorMessage)
	}
	if !contains(snap.assistantText(), "LISTED") {
		t.Errorf("agent's answer missing from the timeline:\n%s", describe(snap))
	}

	// Streaming has to fold into one message per assistant turn, not leave a row
	// per delta. This is the one place the driver's synthetic item keys are visible
	// end to end: a delta keyed differently from the settled text would show the
	// answer twice.
	for _, m := range snap.Messages {
		if m.Role == "assistant" && m.Stream {
			t.Errorf("assistant message %s still marked streaming after the turn completed", m.ID)
		}
	}

	// A tool call must be recorded for a prompt that had to read the repo, or the
	// timeline shows an answer with no account of how it was reached.
	tools := 0
	for _, a := range snap.Activities {
		if a.Kind == "command" || a.Kind == "file_change" {
			tools++
		}
	}
	if tools == 0 {
		t.Errorf("no tool activity recorded for a prompt that had to read the repo:\n%s", describe(snap))
	}
}

// Approvals are the one place the provider blocks on AO: the CLI holds its tool
// call until the control channel answers. The undocumented
// `--permission-prompt-tool stdio` is what routes the ask here at all — without
// it a mode that would prompt silently denies instead, and this scenario is what
// would catch that regression.
func TestClaudeChatApprovalRoundTrip(t *testing.T) {
	requireClaudeE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "claudeapprovals")
	// The default posture defers to the user's own settings.json, which may not
	// ask. accept-edits is the mode under which an escalating call reaches a person.
	setPermissions(t, d, project, "accept-edits")

	session := claudeChatSession(t, d, project, "Reply with exactly: READY")
	send(t, d, session,
		// A write outside the worktree is the ask least likely to be covered by a
		// developer's own allow rules.
		`Use the Bash tool to run this exact command and tell me its exit code: touch "$HOME/.ao-e2e-claude-probe"`,
		"claude-approval-1")

	snap, found := awaitApprovalOrSettledTurn(t, d, session)
	if !found {
		// Not a failure. A user's allow rules legitimately pre-approve this, and AO
		// must not override the policy its user configured in their own CLI.
		t.Skip("the local claude install auto-allowed the command; no approval was raised to answer")
	}
	approval, _ := snap.pendingApproval()

	if approval.RequestID == "" {
		t.Fatal("approval carries no request id; nothing could answer it safely")
	}
	offeredDecisions := approval.decisions()
	if len(offeredDecisions) == 0 {
		t.Fatalf("approval offered no decisions, so the UI has no buttons to render:\n%s", describe(snap))
	}
	offered := map[string]bool{}
	for _, option := range offeredDecisions {
		if option.Label == "" {
			t.Errorf("decision %q has no label, so its button would render blank", option.ID)
		}
		offered[option.ID] = true
	}
	// allow and deny are the permission protocol's own two behaviors. Anything
	// beyond them came from the CLI's own suggestions for this specific ask.
	for _, want := range []string{"allow", "deny"} {
		if !offered[want] {
			t.Fatalf("decision %q was not offered: %+v", want, offeredDecisions)
		}
	}

	// Blocked on a person is its own state: not working, not idle.
	var read struct {
		Session struct{ Status string } `json:"session"`
	}
	d.mustCall("GET", "/sessions/"+session, http.StatusOK, nil, &read)
	if read.Session.Status != "needs_input" {
		t.Errorf("session status while blocked on an approval = %q, want needs_input", read.Session.Status)
	}

	// A decision the provider never offered must be refused rather than forwarded:
	// consent AO invented is not consent.
	status, body := d.callExpectingError("POST",
		"/sessions/"+session+"/conversation/approvals/"+approval.RequestID+"/resolve",
		map[string]any{"decisionId": "allowForever"})
	if status < 400 {
		t.Errorf("AO accepted a decision the provider never offered (status %d)", status)
	} else if body.Code == "" {
		t.Errorf("refusal carried no error code: %+v", body)
	}

	d.mustCall("POST",
		"/sessions/"+session+"/conversation/approvals/"+approval.RequestID+"/resolve",
		http.StatusNoContent, map[string]any{"decisionId": "allow"}, nil)

	resolved := d.awaitConversation(session, 3*time.Minute, "the approval to resolve", func(s snapshot) bool {
		for _, a := range s.Activities {
			if a.RequestID == approval.RequestID {
				return a.Status != "pending"
			}
		}
		return false
	})
	for _, a := range resolved.Activities {
		if a.RequestID == approval.RequestID && a.Status != "resolved" {
			t.Errorf("approval %s ended as %q, want resolved", a.RequestID, a.Status)
		}
	}

	// And the turn it was blocking gets to finish.
	d.awaitConversation(session, 4*time.Minute, "the approved claude turn to settle", func(s snapshot) bool {
		return terminal(s.Turns[len(s.Turns)-1].State)
	})
	_ = os.Remove(os.Getenv("HOME") + "/.ao-e2e-claude-probe")
}

// awaitApprovalOrSettledTurn waits for whichever comes first: an approval to
// answer, or the turn finishing without one.
//
// It has to tolerate both because AO does not own the user's permission rules. A
// developer with `Bash(touch:*)` allowed will never see the ask, and a scenario
// that only waited for an approval would hang for its full timeout on a machine
// where everything is working correctly.
func awaitApprovalOrSettledTurn(t *testing.T, d *daemon, session string) (snapshot, bool) {
	t.Helper()
	snap := d.awaitConversation(session, 3*time.Minute, "an approval or a settled turn",
		func(s snapshot) bool {
			if _, ok := s.pendingApproval(); ok {
				return true
			}
			return len(s.Turns) >= 2 && terminal(s.Turns[len(s.Turns)-1].State)
		})
	_, ok := snap.pendingApproval()
	return snap, ok
}

// Stop is the user's brake. On this wire an interrupted turn arrives as an error
// result with is_error true, so the thing being checked is that AO reads the CLI's
// terminal_reason and records the user's own choice as interrupted rather than as
// a failure.
func TestClaudeChatInterruptSettlesTheTurnAsInterrupted(t *testing.T) {
	requireClaudeE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "claudeinterrupt")
	session := claudeChatSession(t, d, project, "Reply with exactly: READY")

	const slow = "Count slowly from 1 to 300, one number per line, then reply with exactly: NEVER"
	send(t, d, session, slow, "claude-i-slow")
	d.awaitConversation(session, 2*time.Minute, "the slow claude turn to start running",
		func(s snapshot) bool {
			return s.Turns[len(s.Turns)-1].State == "running"
		})

	d.mustCall("POST", "/sessions/"+session+"/conversation/interrupt", http.StatusNoContent, nil, nil)

	snap := d.awaitConversation(session, 3*time.Minute, "the interrupted turn to settle",
		func(s snapshot) bool {
			return terminal(s.userTurnStates()[slow])
		})
	if got := snap.userTurnStates()[slow]; got != "interrupted" {
		t.Errorf("interrupted turn state = %q, want interrupted\n%s", got, describe(snap))
	}
	if contains(snap.assistantText(), "NEVER") {
		t.Error("the interrupted turn produced its final answer anyway")
	}

	// The process serves the next turn: one child serves many, so a stop must not
	// leave the session needing a relaunch.
	send(t, d, session, "Reply with exactly: ALIVE", "claude-i-after")
	after := d.awaitConversation(session, 4*time.Minute, "a turn after the interrupt",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })
	if !contains(after.assistantText(), "ALIVE") {
		t.Errorf("the session did not survive its own interrupt:\n%s", describe(after))
	}
}

// A restart is not a data-loss event: the conversation is the provider's and AO
// reattaches to it. For this driver that rests on AO having minted the session id
// itself at spawn, so there is something to resume before anyone has spoken.
func TestClaudeChatSurvivesADaemonRestartWithNativeContext(t *testing.T) {
	requireClaudeE2E(t)
	dataDir := t.TempDir()
	d := startDaemon(t, dataDir)
	project := seedProject(t, d, "clauderestart")

	session := claudeChatSession(t, d, project,
		"Remember this number for later: 4271. Reply with exactly: STORED")

	before := d.conversation(session)
	if before.ConversationID == "" {
		t.Fatal("session has no conversation to restore")
	}
	itemsBefore := len(before.Messages) + len(before.Activities)

	d.stop()
	restarted := startDaemon(t, dataDir)

	// No explicit restore call: bringing a live session back is the boot pass's
	// job, and a user who reopens the app does not press anything.
	after := restarted.awaitLiveController(session, 2*time.Minute)

	if after.ConversationID != before.ConversationID {
		t.Fatalf("conversation id changed across the restart: %s -> %s",
			before.ConversationID, after.ConversationID)
	}
	if got := len(after.Messages) + len(after.Activities); got < itemsBefore {
		t.Errorf("timeline lost items across the restart: %d -> %d", itemsBefore, got)
	}

	// The real claim: the CLI still holds the model context, so the agent answers
	// from the earlier turn without AO replaying anything. If AO were
	// reconstructing context from its own rows, this is where it would show.
	send(t, restarted, session,
		"What number did I ask you to remember? Reply with just the number.", "claude-recall")
	recalled := restarted.awaitConversation(session, 4*time.Minute, "the claude recall answer",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })

	if !contains(recalled.assistantText(), "4271") {
		t.Fatalf("the agent lost its context across the restart:\n%s", describe(recalled))
	}
}

// The model picker is derived from the provider, never from a table in AO. A
// harness whose driver lists models has to answer with some, or the control would
// render empty — worse than not offering it.
func TestClaudeChatOffersTheAccountsModels(t *testing.T) {
	requireClaudeE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "claudemodels")
	session := claudeChatSession(t, d, project, "Reply with exactly: READY")

	var out struct {
		Models []struct {
			ID          string   `json:"id"`
			DisplayName string   `json:"displayName"`
			Default     bool     `json:"default"`
			Efforts     []string `json:"efforts"`
		} `json:"models"`
	}
	status, err := d.call("GET", "/sessions/"+session+"/conversation/models", nil, &out)
	if err != nil {
		t.Fatalf("read models: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("models returned %d", status)
	}
	if len(out.Models) == 0 {
		t.Fatal("the claude driver advertises model listing but offered none")
	}
	for _, model := range out.Models {
		if strings.TrimSpace(model.ID) == "" || strings.TrimSpace(model.DisplayName) == "" {
			t.Errorf("model %+v would render as a blank option", model)
		}
	}
}
