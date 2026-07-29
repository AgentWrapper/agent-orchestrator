package daytona

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func newTestRuntime(t *testing.T, fc *fakeClient) *Runtime {
	t.Helper()
	rt, err := New(Options{
		Client:       fc,
		ExecTimeout:  2 * time.Second,
		EnterDelay:   time.Millisecond,
		StartTimeout: time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return rt
}

func TestSessionNameMatchesTmuxAdapter(t *testing.T) {
	// Handles must be identical across runtimes so a session migrated between
	// adapters keeps one identity (and operator attach hints stay truthful).
	for _, id := range []string{"agent-orchestrator-70", "weird id/with:chars", strings.Repeat("x", 60)} {
		got, err := sessionName(domain.SessionID(id))
		if err != nil {
			t.Fatalf("sessionName(%q): %v", id, err)
		}
		if want := tmux.SessionName(id); got != want {
			t.Errorf("sessionName(%q) = %q, want tmux.SessionName %q", id, got, want)
		}
	}
}

func TestBuildLaunchCommand(t *testing.T) {
	cmd := buildLaunchCommand(ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/home/daytona/ao/s1",
		Argv:          []string{"claude", "--append-system-prompt", "be nice"},
		Env: map[string]string{
			"CLAUDE_CODE_OAUTH_TOKEN": "tok-123",
			"AO_SESSION_ID":           "s1",
		},
	})
	for _, want := range []string{
		"cd '/home/daytona/ao/s1' || exit",
		"unset NO_COLOR",
		"export CLAUDE_CODE_OAUTH_TOKEN='tok-123'",
		"export AO_SESSION_ID='s1'",
		"export COLORTERM='truecolor'",
		"'claude' '--append-system-prompt' 'be nice'",
		`exec "${SHELL:-/bin/sh}" -i`,
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("launch command missing %q\ncmd: %s", want, cmd)
		}
	}
	// The daemon host's PATH must never leak into the sandbox: no PATH export
	// unless the caller set one.
	if strings.Contains(cmd, "export PATH=") {
		t.Errorf("launch command exports PATH without caller opt-in\ncmd: %s", cmd)
	}
	withPath := buildLaunchCommand(ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/w",
		Argv:          []string{"claude"},
		Env:           map[string]string{"PATH": "/custom/bin", "ZZZ": "last-check"},
	})
	pathIdx := strings.Index(withPath, "export PATH='/custom/bin'")
	zzzIdx := strings.Index(withPath, "export ZZZ=")
	if pathIdx == -1 || zzzIdx == -1 || pathIdx < zzzIdx {
		t.Errorf("PATH must be exported last so explicit overrides win\ncmd: %s", withPath)
	}
}

func TestCreateRequiresProvisionedSandbox(t *testing.T) {
	fc := newFakeClient()
	rt := newTestRuntime(t, fc)
	_, err := rt.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/home/daytona/ao/s1",
		Argv:          []string{"claude"},
	})
	if err == nil || !strings.Contains(err.Error(), "no sandbox") {
		t.Fatalf("err = %v, want no-sandbox error", err)
	}
}

func TestCreateLaunchesTmuxWithEnvAndKeepAlive(t *testing.T) {
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStarted)
	rt := newTestRuntime(t, fc)

	handle, err := rt.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/home/daytona/ao/s1",
		Argv:          []string{"claude", "--append-system-prompt", "be nice"},
		Env: map[string]string{
			"CLAUDE_CODE_OAUTH_TOKEN": "tok-123",
			"AO_SESSION_ID":           "s1",
		},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if handle.ID != "s1" {
		t.Errorf("handle = %q, want s1", handle.ID)
	}
	news := fc.commandsMatching("tmux new-session")
	if len(news) != 1 {
		t.Fatalf("new-session commands = %d, want 1\nall: %v", len(news), fc.commands())
	}
	cmd := news[0]
	// Env/argv mechanics are covered by TestBuildLaunchCommand; here assert the
	// outer tmux wiring: the launch line rides inside sh -c (shell-quoted, so
	// inner quotes appear escaped) and the session gets the same option set as
	// the local tmux adapter.
	for _, want := range []string{
		"tmux new-session -d -s 's1' -x 220 -y 50 -c '/home/daytona/ao/s1' sh -c ",
		"CLAUDE_CODE_OAUTH_TOKEN=",
		"set-option -t 's1' status off",
		"set-option -t 's1' mouse on",
		"set-option -t 's1' window-size largest",
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("create command missing %q\ncmd: %s", want, cmd)
		}
	}
}

func TestCreateWakesParkedSandbox(t *testing.T) {
	fc := newFakeClient()
	id := fc.seedSandbox("s1", StateStopped)
	rt := newTestRuntime(t, fc)
	if _, err := rt.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/w",
		Argv:          []string{"claude"},
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(fc.started) != 1 || fc.started[0] != id {
		t.Errorf("started = %v, want [%s]", fc.started, id)
	}
}

func TestCreateFailsWhenSessionExitsBeforeReady(t *testing.T) {
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStarted)
	fc.onExec("tmux has-session", ExecResult{ExitCode: 1, Result: "can't find session: s1"}, nil)
	rt := newTestRuntime(t, fc)
	_, err := rt.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/w",
		Argv:          []string{"claude"},
	})
	if err == nil || !strings.Contains(err.Error(), "exited before ready") {
		t.Fatalf("err = %v, want exited-before-ready", err)
	}
}

func TestIsAlive(t *testing.T) {
	t.Run("no sandbox is definitively dead", func(t *testing.T) {
		fc := newFakeClient()
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsAlive(context.Background(), ports.RuntimeHandle{ID: "s1"})
		if err != nil || alive {
			t.Fatalf("alive=%v err=%v, want false nil", alive, err)
		}
	})
	t.Run("parked sandbox is alive", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStopped)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsAlive(context.Background(), ports.RuntimeHandle{ID: "s1"})
		if err != nil || !alive {
			t.Fatalf("alive=%v err=%v, want true nil (parked must not be reaped)", alive, err)
		}
		if len(fc.commands()) != 0 {
			t.Errorf("parked probe must not exec, got %v", fc.commands())
		}
	})
	t.Run("missing tmux session is definitively dead", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("tmux has-session", ExecResult{ExitCode: 1, Result: "can't find session: s1"}, nil)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsAlive(context.Background(), ports.RuntimeHandle{ID: "s1"})
		if err != nil || alive {
			t.Fatalf("alive=%v err=%v, want false nil", alive, err)
		}
	})
	t.Run("unrecognized exec failure is an inconclusive probe", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("tmux has-session", ExecResult{ExitCode: 127, Result: "sh: tmux: command not found"}, nil)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsAlive(context.Background(), ports.RuntimeHandle{ID: "s1"})
		if err == nil || alive {
			t.Fatalf("alive=%v err=%v, want false with probe error (never kill on a transient)", alive, err)
		}
	})
	t.Run("list failure is an inconclusive probe", func(t *testing.T) {
		fc := newFakeClient()
		fc.listErr = errors.New("network down")
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsAlive(context.Background(), ports.RuntimeHandle{ID: "s1"})
		if err == nil || alive {
			t.Fatalf("alive=%v err=%v, want false with probe error", alive, err)
		}
	})
	t.Run("error-state sandbox is dead", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateError)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsAlive(context.Background(), ports.RuntimeHandle{ID: "s1"})
		if err != nil || alive {
			t.Fatalf("alive=%v err=%v, want false nil", alive, err)
		}
	})
}

func TestDestroy(t *testing.T) {
	t.Run("kills tmux session, keeps sandbox", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		rt := newTestRuntime(t, fc)
		if err := rt.Destroy(context.Background(), ports.RuntimeHandle{ID: "s1"}); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
		if got := fc.commandsMatching("tmux kill-session"); len(got) != 1 {
			t.Errorf("kill-session commands = %v", got)
		}
		if len(fc.deleted) != 0 {
			t.Errorf("Destroy must not delete the sandbox (Workspace.Destroy owns that), deleted=%v", fc.deleted)
		}
	})
	t.Run("missing sandbox is idempotent success", func(t *testing.T) {
		fc := newFakeClient()
		rt := newTestRuntime(t, fc)
		if err := rt.Destroy(context.Background(), ports.RuntimeHandle{ID: "s1"}); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
	})
	t.Run("parked sandbox is success without exec", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStopped)
		rt := newTestRuntime(t, fc)
		if err := rt.Destroy(context.Background(), ports.RuntimeHandle{ID: "s1"}); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
		if len(fc.commands()) != 0 {
			t.Errorf("no exec expected against a parked sandbox, got %v", fc.commands())
		}
	})
	t.Run("already-gone tmux session is success", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("tmux kill-session", ExecResult{ExitCode: 1, Result: "can't find session: s1"}, nil)
		rt := newTestRuntime(t, fc)
		if err := rt.Destroy(context.Background(), ports.RuntimeHandle{ID: "s1"}); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
	})
}

func TestGetOutput(t *testing.T) {
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStarted)
	fc.onExec("tmux capture-pane", ExecResult{Result: "a\nb\nc\n\n\n"}, nil)
	rt := newTestRuntime(t, fc)
	out, err := rt.GetOutput(context.Background(), ports.RuntimeHandle{ID: "s1"}, 2)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if out != "b\nc\n" {
		t.Errorf("out = %q, want trailing blanks trimmed and tail 2", out)
	}

	t.Run("parked scrollback is unavailable", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStopped)
		rt := newTestRuntime(t, fc)
		if _, err := rt.GetOutput(context.Background(), ports.RuntimeHandle{ID: "s1"}, 10); err == nil {
			t.Fatal("want error for parked sandbox scrollback")
		}
	})
}

func TestSendMessageChunksAndSubmits(t *testing.T) {
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStarted)
	rt := newTestRuntime(t, fc)
	rt.chunkSize = 4

	if err := rt.SendMessage(context.Background(), ports.RuntimeHandle{ID: "s1"}, "hello wörld"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	sends := fc.commandsMatching("send-keys -t 's1' -l")
	if len(sends) < 3 {
		t.Errorf("expected >=3 literal chunks for chunkSize=4, got %d: %v", len(sends), sends)
	}
	var joined strings.Builder
	for _, s := range sends {
		start := strings.Index(s, "-l ") + 3
		joined.WriteString(unquoteShell(s[start:]))
	}
	if joined.String() != "hello wörld" {
		t.Errorf("reassembled chunks = %q, want original message (UTF-8 safe)", joined.String())
	}
	enters := fc.commandsMatching("send-keys -t 's1' Enter")
	if len(enters) != 1 {
		t.Errorf("enter commands = %v, want exactly 1", enters)
	}

	t.Run("empty message sends only Enter", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		rt := newTestRuntime(t, fc)
		if err := rt.SendMessage(context.Background(), ports.RuntimeHandle{ID: "s1"}, ""); err != nil {
			t.Fatalf("SendMessage: %v", err)
		}
		if got := fc.commands(); len(got) != 1 || !strings.Contains(got[0], "Enter") {
			t.Errorf("commands = %v, want single Enter", got)
		}
	})
}

// unquoteShell reverses shellQuote for test reassembly.
func unquoteShell(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "'")
	s = strings.TrimSuffix(s, "'")
	return strings.ReplaceAll(s, `'\''`, "'")
}

func TestRestartFallsBackToNewSessionAfterPark(t *testing.T) {
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStopped)
	// After the wake, tmux is empty: respawn-pane cannot find the session.
	fc.onExec("tmux respawn-pane", ExecResult{ExitCode: 1, Result: "can't find pane: s1:0.0"}, nil)
	rt := newTestRuntime(t, fc)

	handle, err := rt.Restart(context.Background(), ports.RuntimeHandle{ID: "s1"}, ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/w",
		Argv:          []string{"claude", "--resume", "abc"},
	})
	if err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if handle.ID != "s1" {
		t.Errorf("handle changed to %q; restart must preserve terminal identity", handle.ID)
	}
	if len(fc.started) != 1 {
		t.Errorf("expected sandbox wake, started=%v", fc.started)
	}
	if got := fc.commandsMatching("tmux new-session"); len(got) != 1 {
		t.Errorf("expected new-session fallback, got %v", fc.commands())
	}
}

func TestRestartWakesSandboxStillReportedStopping(t *testing.T) {
	// Live regression (PR #3254): the list endpoint lags GetSandbox, so a
	// freshly-parked sandbox can be listed as `stopping`. ensureStarted must
	// settle that into `stopped` and THEN issue the start — the old code
	// waited for `started` without ever starting, and timed out.
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStopping)
	fc.settleAfterGets = 2
	fc.settleTo = StateStopped
	fc.onExec("tmux respawn-pane", ExecResult{ExitCode: 1, Result: "can't find pane: s1:0.0"}, nil)
	rt := newTestRuntime(t, fc)

	if _, err := rt.Restart(context.Background(), ports.RuntimeHandle{ID: "s1"}, ports.RuntimeConfig{
		SessionID:     "s1",
		WorkspacePath: "/w",
		Argv:          []string{"claude"},
	}); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if len(fc.started) != 1 {
		t.Fatalf("StartSandbox calls = %d, want 1 (wake must be issued after the state settles)", len(fc.started))
	}
}

func TestIsSupervisedProcessAlive(t *testing.T) {
	table := `  1     0 /sbin/init
   40     1 tmux server
  100    40 -sh
  200   100 ao agent-process supervise --session s1 --launch L1 -- claude
  300   200 claude
`
	t.Run("matching supervisor generation is alive", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("display-message", ExecResult{Result: "100\n"}, nil)
		fc.onExec("ps -ww", ExecResult{Result: table}, nil)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "s1"},
			ports.SupervisedProcessRef{SessionID: "s1", LaunchID: "L1"})
		if err != nil || !alive {
			t.Fatalf("alive=%v err=%v, want true nil", alive, err)
		}
	})
	t.Run("stale launch generation is dead", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("display-message", ExecResult{Result: "100\n"}, nil)
		fc.onExec("ps -ww", ExecResult{Result: table}, nil)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "s1"},
			ports.SupervisedProcessRef{SessionID: "s1", LaunchID: "L2"})
		if err != nil || alive {
			t.Fatalf("alive=%v err=%v, want false nil (old generation)", alive, err)
		}
	})
	t.Run("parked sandbox means agent exited", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStopped)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "s1"},
			ports.SupervisedProcessRef{SessionID: "s1", LaunchID: "L1"})
		if err != nil || alive {
			t.Fatalf("alive=%v err=%v, want false nil (stop killed the agent)", alive, err)
		}
	})
	t.Run("bare keep-alive shell with no children is exited", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("display-message", ExecResult{Result: "100\n"}, nil)
		fc.onExec("ps -ww", ExecResult{Result: "  1 0 /sbin/init\n  100 40 -sh\n"}, nil)
		rt := newTestRuntime(t, fc)
		alive, err := rt.IsSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "s1"},
			ports.SupervisedProcessRef{SessionID: "s1", LaunchID: "L1"})
		if err != nil || alive {
			t.Fatalf("alive=%v err=%v, want false nil (pane exists but agent gone, #2802)", alive, err)
		}
	})
}
