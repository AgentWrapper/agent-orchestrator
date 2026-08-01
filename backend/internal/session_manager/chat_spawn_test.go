package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// newChatManager mirrors newManager() with a chat launcher injected, so both
// branches can be exercised against the same fakes.
func newChatManager(chat ChatLauncher) (*Manager, *fakeStore, *fakeRuntime) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: &fakeWorkspace{},
		Store:     st,
		Messenger: &fakeMessenger{},
		Chat:      chat,
		Lifecycle: &fakeLCM{store: st},
		LookPath:  lookPath,
	})
	return m, st, rt
}

const chatTestProject = domain.ProjectID("mer")

// The load-bearing property of the split: exactly one controller starts. A chat
// spawn must not touch the terminal runtime, and a TUI spawn must not touch the
// chat launcher. Anything else means two writers on one conversation.

type recordingLauncher struct {
	preflightErr error
	startErr     error
	turnErr      error

	preflighted []domain.AgentHarness
	started     []ChatStart
	turns       []string
	stopped     []domain.SessionID
}

func (l *recordingLauncher) PreflightChat(_ context.Context, harness domain.AgentHarness) error {
	l.preflighted = append(l.preflighted, harness)
	return l.preflightErr
}

func (l *recordingLauncher) StartChat(_ context.Context, cfg ChatStart) (ChatStarted, error) {
	l.started = append(l.started, cfg)
	if l.startErr != nil {
		return ChatStarted{}, l.startErr
	}
	return ChatStarted{
		ProviderConversationID: "thread-1",
		ControllerGeneration:   "gen-1",
	}, nil
}

func (l *recordingLauncher) StartChatTurn(_ context.Context, _ domain.SessionID, text string) (string, error) {
	l.turns = append(l.turns, text)
	return "turn-1", l.turnErr
}

func (l *recordingLauncher) StopChat(_ context.Context, id domain.SessionID) error {
	l.stopped = append(l.stopped, id)
	return nil
}

// An unsupported chat request must be refused before anything durable exists: no
// session row, no worktree, nothing to clean up.
func TestChatSpawnRejectedBeforeDurableStateWhenUnsupported(t *testing.T) {
	mgr, store, _ := newChatManager(&recordingLauncher{preflightErr: ports.ErrChatUnsupported})
	launcher := mgr.chat.(*recordingLauncher)

	_, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID:     chatTestProject,
		Kind:          domain.KindWorker,
		Harness:       domain.HarnessCodex,
		Prompt:        "do the thing",
		RequestedMode: domain.SessionModeChat,
	})
	if !errors.Is(err, ports.ErrChatUnsupported) {
		t.Fatalf("err = %v, want ErrChatUnsupported", err)
	}

	sessions, listErr := store.ListAllSessions(context.Background())
	if listErr != nil {
		t.Fatalf("list sessions: %v", listErr)
	}
	if len(sessions) != 0 {
		t.Fatalf("a refused chat spawn left %d session rows behind", len(sessions))
	}
	if len(launcher.started) != 0 {
		t.Error("a refused preflight still started a controller")
	}
}

// Chat mode with no launcher wired must fail, never silently become a TUI session
// in a terminal the user did not ask for.
func TestChatSpawnWithoutLauncherIsRefusedNotDowngraded(t *testing.T) {
	mgr, _, runtime := newChatManager(nil)

	_, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID:     chatTestProject,
		Kind:          domain.KindWorker,
		Harness:       domain.HarnessCodex,
		RequestedMode: domain.SessionModeChat,
	})
	if !errors.Is(err, ports.ErrChatUnsupported) {
		t.Fatalf("err = %v, want ErrChatUnsupported", err)
	}
	if runtime.created != 0 {
		t.Fatalf("a refused chat spawn created %d runtimes — it downgraded to TUI", runtime.created)
	}
}

// A TUI spawn must never reach the chat launcher, even when one is wired.
func TestTUISpawnNeverTouchesTheChatLauncher(t *testing.T) {
	launcher := &recordingLauncher{}
	mgr, _, runtime := newChatManager(launcher)

	rec, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID: chatTestProject,
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Prompt:    "hello",
		// No requested mode: resolution must land on TUI.
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if rec.Mode != domain.SessionModeTUI {
		t.Fatalf("mode = %q, want tui when none was requested", rec.Mode)
	}
	if len(launcher.preflighted) != 0 || len(launcher.started) != 0 {
		t.Fatalf("a TUI spawn reached the chat launcher: preflight=%v started=%d",
			launcher.preflighted, len(launcher.started))
	}
	if runtime.created == 0 {
		t.Error("a TUI spawn created no runtime")
	}
}

// A chat spawn must persist its mode and provider handle, start no runtime, and
// deliver the initial prompt as a turn.
func TestChatSpawnStartsControllerAndNoRuntime(t *testing.T) {
	launcher := &recordingLauncher{}
	mgr, _, runtime := newChatManager(launcher)

	rec, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID:     chatTestProject,
		Kind:          domain.KindOrchestrator,
		Harness:       domain.HarnessCodex,
		Prompt:        "coordinate the work",
		RequestedMode: domain.SessionModeChat,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	if rec.Mode != domain.SessionModeChat {
		t.Fatalf("mode = %q, want chat", rec.Mode)
	}
	if runtime.created != 0 {
		t.Fatalf("a chat spawn created %d terminal runtimes, want 0", runtime.created)
	}
	if len(launcher.started) != 1 {
		t.Fatalf("started %d controllers, want 1", len(launcher.started))
	}

	start := launcher.started[0]
	if start.WorkspacePath == "" {
		t.Error("controller started with no workspace path")
	}
	// The controller must receive the session env, which is what carries the
	// HookPATH pin in production and is how the agent's own shell commands find
	// `ao` — the mechanism an orchestrator delegates through.
	//
	// The PATH value itself is not asserted here: HookPATH deliberately declines
	// to pin when the running binary is not named "ao", which is always the case
	// under `go test`. That the pin works end to end was verified against a real
	// app-server with a fake `ao` on an injected PATH.
	if start.Env == nil {
		t.Error("controller started with no environment; the agent could not resolve `ao`")
	}
	if start.Env[EnvSessionID] == "" {
		t.Errorf("controller env missing %s; session-scoped hooks would not identify the session", EnvSessionID)
	}

	// The provider handle must be persisted, or a restart cannot resume.
	if rec.Metadata.ProviderConversationID != "thread-1" {
		t.Errorf("provider conversation id = %q", rec.Metadata.ProviderConversationID)
	}
	if rec.Metadata.ControllerGeneration != "gen-1" {
		t.Errorf("controller generation = %q", rec.Metadata.ControllerGeneration)
	}
	// A chat session has no agent pane; leaving these empty is what stops the
	// reaper probing for a terminal that never existed.
	if rec.Metadata.RuntimeHandleID != "" || rec.Metadata.RuntimeLaunchID != "" {
		t.Errorf("chat session carries runtime handles: handle=%q launch=%q",
			rec.Metadata.RuntimeHandleID, rec.Metadata.RuntimeLaunchID)
	}

	if len(launcher.turns) != 1 || launcher.turns[0] == "" {
		t.Fatalf("initial prompt was not delivered as a turn: %v", launcher.turns)
	}
}

// A controller that fails to start must leave nothing running and no live row.
func TestChatSpawnRollsBackWhenControllerFailsToStart(t *testing.T) {
	mgr, store, runtime := newChatManager(&recordingLauncher{startErr: errors.New("app-server exited")})

	_, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID:     chatTestProject,
		Kind:          domain.KindWorker,
		Harness:       domain.HarnessCodex,
		RequestedMode: domain.SessionModeChat,
	})
	if err == nil {
		t.Fatal("expected a failed controller start to fail the spawn")
	}
	if runtime.created != 0 {
		t.Error("a failed chat spawn created a terminal runtime")
	}

	sessions, listErr := store.ListAllSessions(context.Background())
	if listErr != nil {
		t.Fatalf("list sessions: %v", listErr)
	}
	for _, session := range sessions {
		if !session.IsTerminated {
			t.Errorf("session %s left live after a failed chat spawn", session.ID)
		}
	}
}
