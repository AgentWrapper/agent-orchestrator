package tmux

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestRuntimeIntegration(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	id := strings.ReplaceAll(t.Name(), "/", "_")
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
	base := strings.ReplaceAll(t.Name(), "/", "_")
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

func TestRuntimeIntegrationPinsWindowSizeLatest(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux unavailable")
	}

	tmp := t.TempDir()
	confPath := filepath.Join(tmp, "tmux.conf")
	if err := os.WriteFile(confPath, []byte("set-window-option -g window-size smallest\n"), 0o644); err != nil {
		t.Fatalf("write tmux config: %v", err)
	}
	socket := "ao65-" + strings.ReplaceAll(t.Name(), "/", "-")
	wrapperPath := filepath.Join(tmp, "tmux-wrapper")
	wrapper := fmt.Sprintf("#!/bin/sh\nexec %s -L %s -f %s \"$@\"\n", shellQuote(tmuxPath), shellQuote(socket), shellQuote(confPath))
	if err := os.WriteFile(wrapperPath, []byte(wrapper), 0o755); err != nil {
		t.Fatalf("write tmux wrapper: %v", err)
	}

	ctx := context.Background()
	id := strings.ReplaceAll(t.Name(), "/", "_")
	r := New(Options{Binary: wrapperPath, Timeout: 5 * time.Second})

	t.Cleanup(func() {
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id})
		_ = exec.Command(tmuxPath, "-L", socket, "-f", confPath, "kill-server").Run()
	})

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: tmp,
		Argv:          []string{"sh", "-c", "echo ready"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	out, err := exec.Command(tmuxPath, "-L", socket, "-f", confPath, "show-options", "-Awv", "-t", h.ID, "window-size").CombinedOutput()
	if err != nil {
		t.Fatalf("show window-size: %v: %s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "latest" {
		t.Fatalf("window-size = %q, want latest", got)
	}
}

// TestRuntimeIntegrationIsRunningCommand exercises the #219 fix against real
// tmux and a real pgrep prober (via New's default pgrepProber): a healthy
// slow-starting agent — which runs as a non-job-control child of the `sh -c`
// launcher and therefore surfaces "sh" as #{pane_current_command} — must read
// as running, while an agent that exits immediately and leaves only the
// keep-alive shell behind must read as not-running.
func TestRuntimeIntegrationIsRunningCommand(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Skip("pgrep unavailable")
	}

	ctx := context.Background()
	r := New(Options{Timeout: 5 * time.Second})
	// Unique per-run suffix so a rerun never collides with a still-running
	// session from a previous invocation (the launched agents are long-lived).
	uniq := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())

	t.Run("slow-start agent reads as running", func(t *testing.T) {
		id := strings.ReplaceAll(t.Name(), "/", "_") + "-" + uniq
		_ = r.Destroy(ctx, ports.RuntimeHandle{ID: id})
		t.Cleanup(func() { _ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id}) })

		// Simulate a slow wrapper: sleep before exec-ing the agent. Throughout,
		// the launched process is a live child of the launcher, so the
		// naming-based guard (which saw "sh") would have wrongly rejected it.
		// A bounded sleep self-terminates so a missed cleanup cannot linger.
		h, err := r.Create(ctx, ports.RuntimeConfig{
			SessionID:     domain.SessionID(id),
			WorkspacePath: t.TempDir(),
			Argv:          []string{"sh", "-c", "sleep 0.3; exec sleep 5"},
		})
		if err != nil {
			t.Fatalf("Create: %v", err)
		}

		// argv[0] is the agent's launch binary; IsRunningCommand ignores it and
		// relies on the process tree. A healthy start must read as running the
		// whole time — including during the pre-exec sleep window.
		for i := 0; i < 5; i++ {
			running, err := r.IsRunningCommand(ctx, h, "/usr/local/bin/claude")
			if err != nil {
				t.Fatalf("IsRunningCommand: %v", err)
			}
			if !running {
				t.Fatalf("running = false for a live slow-starting agent (attempt %d), want true", i+1)
			}
			time.Sleep(150 * time.Millisecond)
		}
	})

	t.Run("immediate-exit agent reads as not-running", func(t *testing.T) {
		id := strings.ReplaceAll(t.Name(), "/", "_") + "-" + uniq
		_ = r.Destroy(ctx, ports.RuntimeHandle{ID: id})
		t.Cleanup(func() { _ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id}) })

		// The agent exits immediately; buildLaunchCommand's keep-alive shell
		// keeps the tmux session alive but with no children.
		h, err := r.Create(ctx, ports.RuntimeConfig{
			SessionID:     domain.SessionID(id),
			WorkspacePath: t.TempDir(),
			Argv:          []string{"sh", "-c", "true"},
		})
		if err != nil {
			t.Fatalf("Create: %v", err)
		}

		// The session is alive (keep-alive shell) even though the agent exited.
		alive, err := r.IsAlive(ctx, h)
		if err != nil {
			t.Fatalf("IsAlive: %v", err)
		}
		if !alive {
			t.Fatal("IsAlive = false, want true (keep-alive shell keeps the session)")
		}

		// Poll: once the launcher has exec-ed into the childless keep-alive
		// shell, IsRunningCommand must report not-running.
		deadline := time.Now().Add(5 * time.Second)
		for {
			running, err := r.IsRunningCommand(ctx, h, "/usr/local/bin/claude")
			if err != nil {
				t.Fatalf("IsRunningCommand: %v", err)
			}
			if !running {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("running = true for an exited agent with only the keep-alive shell, want false")
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
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
	return out
}
