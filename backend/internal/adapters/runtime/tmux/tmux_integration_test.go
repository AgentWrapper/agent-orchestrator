package tmux

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func integrationSessionID(t *testing.T) string {
	t.Helper()
	var entropy [8]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		t.Fatalf("generate tmux integration session id: %v", err)
	}
	return "ao-test-" + hex.EncodeToString(entropy[:])
}

func TestRuntimeIntegration(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	id := integrationSessionID(t)
	r := New(Options{Timeout: 5 * time.Second})

	// Ensure clean slate: ignore errors (session may not exist).
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: id})

	t.Cleanup(func() {
		// Always destroy so a test failure never leaks a tmux session.
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id})
	})

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: t.TempDir(),
		// Run a trivial command then drop into an interactive shell (the keep-alive
		// exec is added by buildLaunchCommand, but we also verify here that output
		// appears).
		Argv: []string{"sh", "-c", "echo hello-from-tmux"},
		Env:  map[string]string{"AO_SESSION_ID": id},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	alive, err := r.IsAlive(ctx, h)
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if !alive {
		t.Fatal("alive = false, want true after create")
	}

	// Wait for the echo output to appear (the session may take a moment to
	// write it to the pane history).
	out := waitForOutput(t, r, h, "hello-from-tmux", 5*time.Second)
	if !strings.Contains(out, "hello-from-tmux") {
		t.Fatalf("output = %q, want hello-from-tmux", out)
	}

	// Send a command and verify it echoes back.
	if err := r.SendMessage(ctx, h, "echo hello-send"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	out = waitForOutput(t, r, h, "hello-send", 5*time.Second)
	if !strings.Contains(out, "hello-send") {
		t.Fatalf("output after SendMessage = %q, want hello-send", out)
	}

	// Destroy and verify liveness goes false.
	if err := r.Destroy(ctx, h); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	alive, err = r.IsAlive(ctx, h)
	if err != nil {
		t.Fatalf("IsAlive after destroy: %v", err)
	}
	if alive {
		t.Fatal("alive after destroy = true, want false")
	}
}

// TestRuntimeIntegrationExactSessionParsing verifies that IsAlive uses exact
// session matching and does not treat a prefix as a live session.
func TestRuntimeIntegrationExactSessionParsing(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	base := integrationSessionID(t)
	longID := base + "_long"
	prefixID := base

	r := New(Options{Timeout: 5 * time.Second})
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: longID})
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: prefixID})

	t.Cleanup(func() {
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: longID})
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: prefixID})
	})

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(longID),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"sh", "-c", "echo ready"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// tmux has-session -t <prefix> should NOT match <longID> because tmux
	// requires the exact session name when using -t with a plain string (not a
	// glob). Verify by probing the prefix handle directly.
	prefixAlive, err := r.IsAlive(ctx, ports.RuntimeHandle{ID: prefixID})
	if err != nil {
		// tmux may return an error (session not found) rather than exit 0.
		// That is acceptable here: the point is the prefix must not be alive.
		t.Logf("IsAlive prefix returned error (acceptable): %v", err)
	}
	if prefixAlive {
		_ = r.Destroy(ctx, h)
		t.Fatal("prefix handle reported alive; tmux session matching is not exact")
	}
}

type failPostRespawnProbeRunner struct {
	delegate      runner
	mu            sync.Mutex
	probeTargets  map[string]int
	probeFailures int
}

func (r *failPostRespawnProbeRunner) Run(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	target := commandTarget(args)
	if len(args) > 0 && args[0] == "has-session" && r.probeTargets[target] > 0 {
		r.probeTargets[target]--
		if r.probeTargets[target] == 0 {
			delete(r.probeTargets, target)
		}
		r.probeFailures++
		return nil, errors.New("injected post-respawn probe failure")
	}
	out, err := r.delegate.Run(ctx, env, name, args...)
	if err == nil && len(args) > 0 && args[0] == "respawn-pane" {
		paneTarget := commandTarget(args)
		if sessionTarget := strings.TrimSuffix(paneTarget, ":0.0"); sessionTarget != paneTarget {
			if r.probeTargets == nil {
				r.probeTargets = make(map[string]int)
			}
			r.probeTargets[exactSessionTarget(sessionTarget)]++
		}
	}
	return out, err
}

func (r *failPostRespawnProbeRunner) ProbeFailures() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.probeFailures
}

func commandTarget(args []string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-t" {
			return args[i+1]
		}
	}
	return ""
}

func TestFailPostRespawnProbeRunnerIsConcurrentAndTargetSpecific(t *testing.T) {
	probeRunner := &failPostRespawnProbeRunner{
		delegate: runnerFunc(func(_ context.Context, _ []string, _ string, _ ...string) ([]byte, error) {
			return nil, nil
		}),
	}
	if _, err := probeRunner.Run(context.Background(), nil, "tmux", respawnPaneArgs("target", "/tmp/ws", "/bin/sh", "true")...); err != nil {
		t.Fatal(err)
	}
	if _, err := probeRunner.Run(context.Background(), nil, "tmux", hasSessionArgs("other")...); err != nil {
		t.Fatalf("unrelated probe consumed injected failure: %v", err)
	}

	const probes = 32
	results := make(chan error, probes)
	for i := 0; i < probes; i++ {
		go func() {
			_, err := probeRunner.Run(context.Background(), nil, "tmux", hasSessionArgs("target")...)
			results <- err
		}()
	}
	failures := 0
	for i := 0; i < probes; i++ {
		if err := <-results; err != nil {
			if !strings.Contains(err.Error(), "injected post-respawn probe failure") {
				t.Fatalf("unexpected probe error: %v", err)
			}
			failures++
		}
	}
	if failures != 1 {
		t.Fatalf("concurrent injected failures = %d, want 1", failures)
	}
	if got := probeRunner.ProbeFailures(); got != 1 {
		t.Fatalf("recorded probe failures = %d, want 1", got)
	}
}

func TestFailPostRespawnProbeRunnerTracksInterleavedTargets(t *testing.T) {
	probeRunner := &failPostRespawnProbeRunner{
		delegate: runnerFunc(func(_ context.Context, _ []string, _ string, _ ...string) ([]byte, error) {
			return nil, nil
		}),
	}
	for _, target := range []string{"target-a", "target-b"} {
		if _, err := probeRunner.Run(context.Background(), nil, "tmux", respawnPaneArgs(target, "/tmp/ws", "/bin/sh", "true")...); err != nil {
			t.Fatal(err)
		}
	}
	for _, target := range []string{"target-a", "target-b"} {
		if _, err := probeRunner.Run(context.Background(), nil, "tmux", hasSessionArgs(target)...); err == nil ||
			!strings.Contains(err.Error(), "injected post-respawn probe failure") {
			t.Fatalf("target %s probe error = %v, want its own injected failure", target, err)
		}
	}
	if got := probeRunner.ProbeFailures(); got != 2 {
		t.Fatalf("recorded interleaved probe failures = %d, want 2", got)
	}
}

func TestRuntimeIntegrationRestartPreservesAppliedHandleWhenProbeFails(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	id := integrationSessionID(t)
	r := New(Options{Timeout: 5 * time.Second})
	probeRunner := &failPostRespawnProbeRunner{delegate: r.runner}
	r.runner = probeRunner
	tmuxID := SessionName(id)
	workspace := t.TempDir()
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: tmuxID})
	t.Cleanup(func() { _ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: tmuxID}) })

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo real-generation-one"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	waitForOutput(t, r, h, "real-generation-one", 5*time.Second)

	restarted, err := r.Restart(ctx, h, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo real-generation-two"},
	})
	if restarted != h {
		t.Fatalf("restart handle = %+v, want owned handle %+v", restarted, h)
	}
	var applied *ports.RestartAppliedUnverifiedError
	if !errors.As(err, &applied) {
		t.Fatalf("Restart error = %v, want RestartAppliedUnverifiedError", err)
	}
	if got := probeRunner.ProbeFailures(); got != 1 {
		t.Fatalf("injected probe failures = %d, want 1", got)
	}

	alive, probeErr := r.IsAlive(ctx, restarted)
	if probeErr != nil || !alive {
		t.Fatalf("real restarted tmux session = (%v, %v), want (true, nil)", alive, probeErr)
	}
	out := waitForOutput(t, r, restarted, "real-generation-two", 5*time.Second)
	if !strings.Contains(out, "real-generation-two") {
		t.Fatalf("restarted output = %q, want real-generation-two", out)
	}
}

func TestRuntimeIntegrationSupervisedExitKeepsInteractiveShell(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	id := integrationSessionID(t)
	const launchID = "launch-1"
	r := New(Options{Timeout: 5 * time.Second})
	tmuxID := SessionName(id)
	workspace := t.TempDir()
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: tmuxID})
	t.Cleanup(func() { _ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: tmuxID}) })

	// Re-run this test binary as a long-lived helper with the same controlled
	// command-line identity as AO's supervisor. The CLI package separately tests
	// that the real supervisor waits for and reports its child.
	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: workspace,
		Argv:          []string{os.Args[0], "-test.run=TestSupervisorProcessHelper", "--", "agent-process", "supervise", "--session", id, "--launch", launchID, "--"},
		Env:           map[string]string{"AO_TMUX_SUPERVISOR_HELPER": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ref := ports.SupervisedProcessRef{SessionID: domain.SessionID(id), LaunchID: launchID}
	deadline := time.Now().Add(5 * time.Second)
	for {
		alive, probeErr := r.IsSupervisedProcessAlive(ctx, h, ref)
		if probeErr != nil {
			t.Fatal(probeErr)
		}
		if alive {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supervised workload did not appear in the tmux process tree")
		}
		time.Sleep(100 * time.Millisecond)
	}

	// The helper exits normally, matching Codex /exit or EOF. The launch shell
	// must then execute AO's keep-alive interactive shell.
	deadline = time.Now().Add(5 * time.Second)
	for {
		alive, probeErr := r.IsSupervisedProcessAlive(ctx, h, ref)
		if probeErr != nil {
			t.Fatal(probeErr)
		}
		if !alive {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supervised workload remained alive after normal exit")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if alive, err := r.IsAlive(ctx, h); err != nil || !alive {
		t.Fatalf("tmux after workload exit = (%v, %v), want (true, nil)", alive, err)
	}
	if err := r.SendMessage(ctx, h, "echo shell-after-agent-exit"); err != nil {
		t.Fatal(err)
	}
	out := waitForOutput(t, r, h, "shell-after-agent-exit", 5*time.Second)
	if !strings.Contains(out, "shell-after-agent-exit") {
		t.Fatalf("post-exit shell output = %q", out)
	}

	restarted, err := r.Restart(ctx, h, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo managed-agent-resumed"},
	})
	if err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if restarted != h {
		t.Fatalf("restart handle = %+v, want existing handle %+v", restarted, h)
	}
	out = waitForOutput(t, r, restarted, "managed-agent-resumed", 5*time.Second)
	if !strings.Contains(out, "managed-agent-resumed") {
		t.Fatalf("restart output = %q, want managed-agent-resumed", out)
	}
	if err := r.SendMessage(ctx, restarted, "echo shell-after-managed-resume"); err != nil {
		t.Fatal(err)
	}
	out = waitForOutput(t, r, restarted, "shell-after-managed-resume", 5*time.Second)
	if !strings.Contains(out, "shell-after-managed-resume") {
		t.Fatalf("post-resume shell output = %q", out)
	}
}

func TestSupervisorProcessHelper(t *testing.T) {
	if os.Getenv("AO_TMUX_SUPERVISOR_HELPER") != "1" {
		return
	}
	time.Sleep(2 * time.Second)
}

// waitForOutput polls GetOutput until out contains want or the deadline passes.
func waitForOutput(t *testing.T, r *Runtime, h ports.RuntimeHandle, want string, deadline time.Duration) string {
	t.Helper()
	end := time.Now().Add(deadline)
	var out string
	for time.Now().Before(end) {
		var err error
		out, err = r.GetOutput(context.Background(), h, 50)
		if err != nil {
			t.Fatalf("GetOutput: %v", err)
		}
		if strings.Contains(out, want) {
			return out
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q in tmux output: %q", want, out)
	return out
}
