package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/daemonmeta"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

// TestDecideEnsureAction table-tests the pure decision function against every
// daemonState inspectDaemon can report.
func TestDecideEnsureAction(t *testing.T) {
	tests := []struct {
		state daemonState
		want  ensureAction
	}{
		{stateReady, ensureActionAttach},
		{stateStopped, ensureActionSpawn},
		{stateStale, ensureActionSpawn},
		{stateUnhealthy, ensureActionTakeover},
		{stateNotReady, ensureActionTakeover},
	}
	for _, tt := range tests {
		t.Run(string(tt.state), func(t *testing.T) {
			got := decideEnsureAction(daemonStatus{State: tt.state})
			if got != tt.want {
				t.Fatalf("decideEnsureAction(%s) = %s, want %s", tt.state, got, tt.want)
			}
		})
	}
}

// TestEnsureAttachesToHealthyDaemon covers the attach path: a fake healthy
// daemon is already recorded in running.json, so ensure must not spawn.
func TestEnsureAttachesToHealthyDaemon(t *testing.T) {
	cfg := setConfigEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			_, _ = fmt.Fprintf(w, `{"status":"ok","service":%q,"pid":%d}`, daemonmeta.ServiceName, os.Getpid())
		case "/readyz":
			_, _ = fmt.Fprintf(w, `{"status":"ready","service":%q,"pid":%d}`, daemonmeta.ServiceName, os.Getpid())
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	port := serverPort(t, srv.URL)
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: port, StartedAt: time.Unix(100, 0).UTC()}); err != nil {
		t.Fatal(err)
	}

	spawned := false
	c := &commandContext{deps: Deps{
		ProcessAlive: func(pid int) bool { return pid == os.Getpid() },
		StartProcess: func(processStartConfig) error { spawned = true; return nil },
		Now:          time.Now,
		Sleep:        func(time.Duration) {},
	}.withDefaults()}

	res, err := c.ensureDaemon(context.Background(), ensureOptions{owner: ownerApp, timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != string(ensureActionAttach) {
		t.Fatalf("mode = %q, want attach", res.Mode)
	}
	if res.Port != port || res.PID != os.Getpid() {
		t.Fatalf("result = %+v, want port=%d pid=%d", res, port, os.Getpid())
	}
	if spawned {
		t.Fatal("ensure spawned a daemon despite a healthy attach target")
	}
}

// TestEnsureSpawnsWhenRunFileStale covers the stale-file decision: a run-file
// naming a dead PID must be cleaned up and a fresh daemon spawned.
func TestEnsureSpawnsWhenRunFileStale(t *testing.T) {
	cfg := setConfigEnv(t)
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: 999999, Port: 3001, StartedAt: time.Unix(100, 0).UTC()}); err != nil {
		t.Fatal(err)
	}

	now := time.Unix(300, 0).UTC()
	spawnCalls := 0
	c := &commandContext{deps: Deps{
		ProcessAlive: func(int) bool { return false },
		Executable:   func() (string, error) { return "/fake/ao", nil },
		StartProcess: func(cfg processStartConfig) error {
			spawnCalls++
			if cfg.Path != "/fake/ao" || len(cfg.Args) != 1 || cfg.Args[0] != "daemon" {
				t.Fatalf("unexpected spawn config: %+v", cfg)
			}
			// The fake daemon never actually writes running.json, so ensure
			// will time out below; this test only asserts the stale-cleanup
			// and single-spawn behavior.
			return nil
		},
		Now:   func() time.Time { return now },
		Sleep: func(d time.Duration) { now = now.Add(d) },
	}.withDefaults()}

	_, err := c.ensureDaemon(context.Background(), ensureOptions{owner: ownerApp, timeout: time.Second})
	if err == nil {
		t.Fatal("expected the fake spawn (which never actually writes a healthy run-file) to time out")
	}
	if spawnCalls != 1 {
		t.Fatalf("spawn calls = %d, want 1", spawnCalls)
	}
	info, readErr := runfile.Read(cfg.runFile)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if info != nil && info.PID == 999999 {
		t.Fatal("stale run-file was not cleaned up before spawn")
	}
}

// TestEnsureTakesOverWedgedDaemon covers the wedged-orphan path: a live PID
// that never answers /healthz must be killed (SIGTERM then SIGKILL after the
// grace period) before ensure spawns a replacement.
func TestEnsureTakesOverWedgedDaemon(t *testing.T) {
	cfg := setConfigEnv(t)
	const wedgedPID = 424242
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: wedgedPID, Port: closedPort(t), StartedAt: time.Unix(100, 0).UTC()}); err != nil {
		t.Fatal(err)
	}

	now := time.Unix(200, 0).UTC()
	var terminated, killed bool
	aliveUntilKilled := true
	c := &commandContext{deps: Deps{
		ProcessAlive: func(pid int) bool {
			if pid != wedgedPID {
				return false
			}
			return aliveUntilKilled
		},
		TerminateProcessGroup: func(pid int) error {
			if pid != wedgedPID {
				t.Fatalf("terminated wrong pid %d", pid)
			}
			terminated = true
			return nil
		},
		KillProcessGroup: func(pid int) error {
			if pid != wedgedPID {
				t.Fatalf("killed wrong pid %d", pid)
			}
			killed = true
			aliveUntilKilled = false
			return nil
		},
		Executable: func() (string, error) {
			return "", errors.New("spawn should not be reached in this timeout scenario without more setup")
		},
		Now:   func() time.Time { return now },
		Sleep: func(d time.Duration) { now = now.Add(d) },
	}.withDefaults()}

	deadline := now.Add(5 * time.Second)
	err := c.takeoverWedgedDaemon(context.Background(), wedgedPID, deadline)
	if err != nil {
		t.Fatal(err)
	}
	if !terminated {
		t.Fatal("takeoverWedgedDaemon did not send a graceful terminate signal")
	}
	if !killed {
		t.Fatal("takeoverWedgedDaemon did not escalate to a force kill after the grace period")
	}
}

// TestEnsureTakeoverSkipsForceKillWhenTerminateSucceeds confirms the grace
// period is not always fully consumed: once the process exits after the
// graceful signal, no SIGKILL should be sent.
func TestEnsureTakeoverSkipsForceKillWhenTerminateSucceeds(t *testing.T) {
	const wedgedPID = 424242
	now := time.Unix(200, 0).UTC()
	aliveChecks := 0
	killed := false
	c := &commandContext{deps: Deps{
		ProcessAlive: func(pid int) bool {
			aliveChecks++
			return aliveChecks < 2 // dies right after the terminate signal
		},
		TerminateProcessGroup: func(int) error { return nil },
		KillProcessGroup:      func(int) error { killed = true; return nil },
		Now:                   func() time.Time { return now },
		Sleep:                 func(d time.Duration) { now = now.Add(d) },
	}.withDefaults()}

	if err := c.takeoverWedgedDaemon(context.Background(), wedgedPID, now.Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	if killed {
		t.Fatal("force kill was sent even though the process exited after the graceful signal")
	}
}

// TestEnsureTimesOutWhenDaemonNeverBecomesReady covers the timeout path: the
// spawned daemon never writes a healthy run-file, so ensure must fail once the
// deadline (driven by the injected, non-real-time Now/Sleep) passes rather
// than hang.
func TestEnsureTimesOutWhenDaemonNeverBecomesReady(t *testing.T) {
	setConfigEnv(t)
	now := time.Unix(200, 0).UTC()
	sleeps := 0
	c := &commandContext{deps: Deps{
		ProcessAlive: func(int) bool { return false },
		Executable:   func() (string, error) { return "/fake/ao", nil },
		StartProcess: func(processStartConfig) error { return nil }, // never actually writes running.json
		Now:          func() time.Time { return now },
		Sleep: func(d time.Duration) {
			sleeps++
			now = now.Add(d)
		},
	}.withDefaults()}

	_, err := c.ensureDaemon(context.Background(), ensureOptions{owner: ownerApp, timeout: time.Second})
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if !strings.Contains(err.Error(), "did not become ready") {
		t.Fatalf("error = %v, want a ready-timeout message", err)
	}
	if sleeps == 0 {
		t.Fatal("ensure returned before polling for readiness")
	}
}

// TestNewDaemonEnsureCommandFlags confirms the three documented flags are
// registered with the expected defaults.
func TestNewDaemonEnsureCommandFlags(t *testing.T) {
	cmd := newDaemonEnsureCommand(&commandContext{deps: Deps{}.withDefaults()})
	for _, name := range []string{"owner", "json", "timeout"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("flag %q not registered", name)
		}
	}
	if got := cmd.Flags().Lookup("owner").DefValue; got != "app" {
		t.Fatalf("--owner default = %q, want app", got)
	}
	if got := cmd.Flags().Lookup("timeout").DefValue; got != defaultEnsureTimeout.String() {
		t.Fatalf("--timeout default = %q, want %s", got, defaultEnsureTimeout)
	}
}

// TestEnsureRejectsInvalidOwner covers flag validation: an --owner value
// outside app|persistent must be a usage error (exit code 2).
func TestEnsureRejectsInvalidOwner(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return false }}, "daemon", "ensure", "--owner", "bogus")
	if err == nil {
		t.Fatal("expected a usage error for an invalid --owner value")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("ExitCode(%v) = %d, want 2", err, got)
	}
}
