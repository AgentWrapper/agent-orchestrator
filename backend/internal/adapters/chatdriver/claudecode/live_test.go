package claudecode

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestLiveClaudeCode drives a real `claude`. It is skipped unless
// AO_CLAUDE_LIVE=1, because it needs a local Claude Code install, working auth,
// and it makes real model calls. Everything else in this package runs against
// pipes.
//
// Run it after changing the protocol layer:
//
//	AO_CLAUDE_LIVE=1 go test ./internal/adapters/chatdriver/claudecode/ -run Live -v
//
// It proves the four things the production floor rests on — a turn answers with
// streamed text, an approval round-trips, an interrupt lands and the process
// survives it, and resume recovers context on a fresh process — because each of
// those is a claim about the CLI that only the CLI can settle.
func TestLiveClaudeCode(t *testing.T) {
	if os.Getenv("AO_CLAUDE_LIVE") != "1" {
		t.Skip("set AO_CLAUDE_LIVE=1 to run against a real claude install")
	}

	bin := os.Getenv("AO_CLAUDE_BIN")
	if bin == "" {
		bin = "claude"
	}
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("claude binary %q not on PATH: %v", bin, err)
	}

	workspace := t.TempDir()
	seedGitWorkspace(t, workspace)

	d := New(livePlugin{bin: bin}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))

	caps, err := d.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) != 0 {
		t.Fatalf("missing production capabilities: %v", missing)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	conv, err := d.Start(ctx, ports.ChatStartConfig{
		SessionID:     "ao-live",
		WorkspacePath: workspace,
		Env:           envMap(),
		// accept-edits is the AO mode under which approvals actually reach a person:
		// bypass skips every check and auto lets a classifier decide. Even here the
		// user's own settings.json allow rules can suppress an ask, so the approval
		// assertion below tolerates that rather than pretending AO controls them.
		Permissions:  ports.PermissionModeAcceptEdits,
		SystemPrompt: "You are in an automated test. Answer in one short sentence.",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	sessionID := conv.ProviderConversationID()
	if sessionID == "" {
		t.Fatal("no provider conversation id after Start")
	}
	t.Logf("session %s", sessionID)

	// 1. A turn answers, and it streams.
	ref, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "Remember the number 4271. Reply with exactly the word: acknowledged",
		ClientMessageID: "live-1",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}

	var (
		sawDelta bool
		sawUsage bool
		state    domain.TurnState
	)
collect:
	for {
		select {
		case ev, ok := <-conv.Events():
			if !ok {
				t.Fatal("event stream closed before the turn completed")
			}
			switch ev.Kind {
			case ports.ChatEventMessageDelta:
				sawDelta = true
			case ports.ChatEventUsage:
				if ev.Usage != nil && ev.Usage.ContextUsed > 0 {
					sawUsage = true
				}
			case ports.ChatEventApprovalRequested:
				_ = conv.ResolveRequest(ctx, ev.RequestID, ports.ChatDecision{ID: decisionAllow})
			case ports.ChatEventTurnCompleted:
				if ev.ProviderTurnID != ref.ProviderTurnID {
					t.Errorf("turn %q completed, want %q", ev.ProviderTurnID, ref.ProviderTurnID)
				}
				state = ev.TurnState
				break collect
			case ports.ChatEventControllerState:
				if ev.ControllerState == ports.ChatControllerStopped {
					t.Fatalf("controller stopped before the turn completed: %v", ev.Err)
				}
			}
		case <-ctx.Done():
			t.Fatalf("timed out: %v", ctx.Err())
		}
	}

	if !sawDelta {
		t.Error("no streaming deltas observed")
	}
	if !sawUsage {
		t.Error("no usage with a context position observed")
	}
	if state != domain.TurnStateCompleted {
		t.Errorf("turn state = %q, want completed", state)
	}

	// 2. An approval round-trips. Under acceptEdits an edit inside the working
	// directory is auto-accepted, so the ask has to come from a path outside it —
	// that is the escalation a developer's own allow rules are least likely to
	// already cover.
	outside := filepath.Join(t.TempDir(), "outside-the-worktree.txt")
	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text: "Use the Write tool to create the file " + outside +
			" containing the word hello. Do not use Bash. Then stop.",
		ClientMessageID: "live-2",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn (approval): %v", err)
	}

	sawApproval := false
approvals:
	for {
		select {
		case ev, ok := <-conv.Events():
			if !ok {
				t.Fatal("event stream closed during the approval turn")
			}
			switch ev.Kind {
			case ports.ChatEventApprovalRequested:
				sawApproval = true
				if len(ev.Decisions) == 0 {
					t.Fatal("an approval was raised with no decisions to answer it")
				}
				if err := conv.ResolveRequest(ctx, ev.RequestID, ports.ChatDecision{ID: decisionAllow}); err != nil {
					t.Fatalf("ResolveRequest: %v", err)
				}
			case ports.ChatEventTurnCompleted:
				break approvals
			}
		case <-ctx.Done():
			t.Fatalf("timed out on the approval turn: %v", ctx.Err())
		}
	}
	if sawApproval {
		t.Log("approval round-tripped")
	} else {
		// Not a failure: the user's own settings.json allow rules legitimately
		// suppress the ask, and AO does not and should not override them.
		t.Log("no approval was raised; the local install auto-allows this tool")
	}

	// 3. An interrupt lands, and the process keeps serving.
	longRef, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "Count slowly from 1 to 300, one number per line.",
		ClientMessageID: "live-3",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("SendTurn (interrupt): %v", err)
	}
	// Wait for the CLI to acknowledge the turn: before system/init there is
	// nothing for an interrupt to cancel.
	waitFor(ctx, t, conv, ports.ChatEventTurnStarted)
	if err := conv.Interrupt(ctx, longRef.ProviderTurnID); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	stopped := waitFor(ctx, t, conv, ports.ChatEventTurnCompleted)
	if stopped.TurnState != domain.TurnStateInterrupted {
		t.Errorf("interrupted turn settled as %q, want interrupted", stopped.TurnState)
	}

	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "Reply with exactly: alive",
		ClientMessageID: "live-4",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn after interrupt: %v", err)
	}
	alive := waitFor(ctx, t, conv, ports.ChatEventTurnCompleted)
	if alive.TurnState != domain.TurnStateCompleted {
		t.Errorf("the process did not survive its own interrupt: %q", alive.TurnState)
	}

	// 4. Resume on a fresh process recovers the same session AND its context.
	// This is the daemon-restart path.
	if err := conv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	resumed, err := d.Resume(ctx, ports.ChatResumeConfig{
		SessionID:              "ao-live",
		ProviderConversationID: sessionID,
		WorkspacePath:          workspace,
		Env:                    envMap(),
		Permissions:            ports.PermissionModeAcceptEdits,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	defer func() { _ = resumed.Close() }()

	if got := resumed.ProviderConversationID(); got != sessionID {
		t.Fatalf("resumed session = %q, want %q", got, sessionID)
	}

	if _, err := resumed.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "What number did I ask you to remember? Reply with just the number.",
		ClientMessageID: "live-5",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn after resume: %v", err)
	}

	var recalled string
recall:
	for {
		select {
		case ev, ok := <-resumed.Events():
			if !ok {
				t.Fatal("event stream closed after resume")
			}
			switch ev.Kind {
			case ports.ChatEventMessageCompleted:
				recalled += ev.Text
			case ports.ChatEventTurnCompleted:
				break recall
			}
		case <-ctx.Done():
			t.Fatalf("timed out after resume: %v", ctx.Err())
		}
	}
	if !strings.Contains(recalled, "4271") {
		t.Errorf("resumed session did not recall the planted number; answered %q", recalled)
	}
	t.Logf("resumed session %s recovered its context", sessionID)

	// The optional interfaces, exercised against the live install rather than
	// asserted from a fixture.
	if lister, ok := resumed.(ports.ChatModelLister); ok {
		models, err := lister.ListModels(ctx)
		if err != nil {
			t.Errorf("ListModels: %v", err)
		} else if len(models) == 0 {
			t.Error("ListModels returned nothing; a picker that offers nothing is worse than none")
		} else {
			t.Logf("%d models offered, first %q", len(models), models[0].ID)
		}
	}
	if reporter, ok := resumed.(ports.ChatUsageReporter); ok {
		limits, err := reporter.ReadRateLimits(ctx)
		if err != nil {
			t.Errorf("ReadRateLimits: %v", err)
		} else {
			t.Logf("rate limits: primary %.0f%% secondary %.0f%% plan %q",
				limits.PrimaryUsedPercent, limits.SecondaryUsedPercent, limits.PlanLabel)
		}
	}
	if renamer, ok := resumed.(ports.ChatRenamer); ok {
		if err := renamer.SetTitle(ctx, "AO live test"); err != nil {
			t.Errorf("SetTitle: %v", err)
		}
	}
}

// waitFor drains events until one of the wanted kind arrives.
func waitFor(
	ctx context.Context, t *testing.T, conv ports.ChatConversation, kind ports.ChatEventKind,
) ports.ChatEvent {
	t.Helper()
	for {
		select {
		case ev, ok := <-conv.Events():
			if !ok {
				t.Fatalf("event stream closed while waiting for %s", kind)
			}
			if ev.Kind == ports.ChatEventControllerState && ev.ControllerState == ports.ChatControllerStopped {
				t.Fatalf("controller stopped while waiting for %s: %v", kind, ev.Err)
			}
			if ev.Kind == kind {
				return ev
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s: %v", kind, ctx.Err())
		}
	}
}

// livePlugin stands in for AO's Claude Code agent plugin so this test exercises
// the driver rather than binary discovery.
type livePlugin struct{ bin string }

func (p livePlugin) ResolveBinary(context.Context) (string, error) { return p.bin, nil }
func (p livePlugin) AuthStatus(context.Context) (ports.AgentAuthStatus, error) {
	return ports.AgentAuthStatusAuthorized, nil
}

func envMap() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				out[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	return out
}

func seedGitWorkspace(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "."},
		{"-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "seed"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
}
