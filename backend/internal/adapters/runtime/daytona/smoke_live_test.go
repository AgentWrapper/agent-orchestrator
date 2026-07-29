package daytona

// Live smoke tests against the real Daytona API. They are skipped unless
// DAYTONA_API_KEY is set (mirroring how tmux_integration_test gates on a real
// tmux); CI never runs them. Optional env:
//
//	DAYTONA_API_URL          – API base override (default https://app.daytona.io/api)
//	AO_DAYTONA_SNAPSHOT      – snapshot with tmux/git (and for the agent test,
//	                           an agent CLI) preinstalled; default: Daytona's
//	                           default snapshot, with a best-effort tmux install
//	AO_DAYTONA_AGENT_ARGV    – JSON argv for the real-agent demo test, e.g.
//	                           ["claude","-p","say hello"]
//
// Cost note: each test creates one default-size sandbox (~$0.067/h) and
// deletes it on exit; a full run is a few sandbox-minutes.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func liveClient(t *testing.T) *apiClient {
	t.Helper()
	key := os.Getenv("DAYTONA_API_KEY")
	if key == "" {
		t.Skip("DAYTONA_API_KEY not set; skipping live Daytona smoke test")
	}
	c, err := NewClient(ClientOptions{APIKey: key, APIURL: os.Getenv("DAYTONA_API_URL")})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// ensureTmux makes tmux available in the sandbox, installing it when the
// snapshot lacks it. Skips the calling test when installation is impossible.
func ensureTmux(t *testing.T, c Client, sandboxID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	res, err := c.Exec(ctx, sandboxID, ExecRequest{
		Command: "tmux -V || (sudo apt-get update -qq && sudo apt-get install -y -qq tmux) || " +
			"(apt-get update -qq && apt-get install -y -qq tmux)",
		TimeoutSeconds: 170,
	})
	if err != nil {
		t.Fatalf("ensure tmux: %v", err)
	}
	if res.ExitCode != 0 {
		t.Skipf("snapshot has no tmux and install failed (exit %d): %s — set AO_DAYTONA_SNAPSHOT to a tmux-equipped snapshot", res.ExitCode, res.Result)
	}
}

func liveWorkspace(t *testing.T, c Client) *Workspace {
	t.Helper()
	ws, err := NewWorkspace(WorkspaceOptions{
		Client:   c,
		Snapshot: os.Getenv("AO_DAYTONA_SNAPSHOT"),
		ResolveRepo: func(context.Context, ports.WorkspaceConfig) (RepoRemote, error) {
			return RepoRemote{URL: "https://github.com/octocat/Hello-World.git", DefaultBranch: "master"}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewWorkspace: %v", err)
	}
	return ws
}

// smokeSessionID is unique per run so concurrent/aborted runs never collide on
// sandbox labels.
func smokeSessionID(t *testing.T) string {
	return fmt.Sprintf("ao-smoke-%s-%d", strings.ToLower(t.Name()[strings.LastIndex(t.Name(), "_")+1:]), time.Now().Unix())
}

func TestLive_ClientSandboxLifecycle(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	sb, err := c.CreateSandbox(ctx, CreateSandboxRequest{
		Snapshot: os.Getenv("AO_DAYTONA_SNAPSHOT"),
		Labels:   map[string]string{LabelSession: smokeSessionID(t)},
	})
	if err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}
	t.Cleanup(func() { _ = c.DeleteSandbox(context.Background(), sb.ID) })
	core := core{client: c, execTimeout: 60 * time.Second, startTimeout: 2 * time.Minute}
	if _, err := core.waitForState(ctx, sb.ID, StateStarted, 5*time.Minute); err != nil {
		t.Fatalf("wait started: %v", err)
	}

	res, err := c.Exec(ctx, sb.ID, ExecRequest{Command: "echo live-smoke-$((20+3))", TimeoutSeconds: 30})
	if err != nil || res.ExitCode != 0 || !strings.Contains(res.Result, "live-smoke-23") {
		t.Fatalf("exec: res=%+v err=%v", res, err)
	}

	// PTY round-trip: write a command, expect its output back over the socket.
	pty, err := c.OpenPTY(ctx, sb.ID, PTYSpec{ID: "ao-smoke-pty", Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("OpenPTY: %v", err)
	}
	defer func() { _ = pty.Close() }()
	if _, err := pty.Write([]byte("echo pty-rt-$((40+2))\n")); err != nil {
		t.Fatalf("pty write: %v", err)
	}
	if err := pty.Resize(30, 100); err != nil {
		t.Errorf("pty resize: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	var seen strings.Builder
	buf := make([]byte, 4096)
	for time.Now().Before(deadline) && !strings.Contains(seen.String(), "pty-rt-42") {
		n, err := pty.Read(buf)
		if n > 0 {
			seen.Write(buf[:n])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("pty read: %v (seen: %q)", err, seen.String())
		}
	}
	if !strings.Contains(seen.String(), "pty-rt-42") {
		t.Fatalf("pty output missing marker; seen: %q", seen.String())
	}
}

// TestLive_RuntimeSessionLifecycle is the exit-criteria flow minus the real
// agent binary: workspace (sandbox + clone) → tmux-hosted process → output
// capture → message round-trip → park → wake/restart → teardown.
func TestLive_RuntimeSessionLifecycle(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	sessionID := smokeSessionID(t)
	ws := liveWorkspace(t, c)
	rt, err := New(Options{Client: c, ExecTimeout: 60 * time.Second, StartTimeout: 3 * time.Minute})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	info, err := ws.Create(ctx, ports.WorkspaceConfig{
		ProjectID: "ao-smoke",
		SessionID: domain.SessionID(sessionID),
		Branch:    "ao/smoke/root",
	})
	if err != nil {
		t.Fatalf("workspace create: %v", err)
	}
	t.Cleanup(func() { _ = ws.ForceDestroy(context.Background(), info) })

	handleName, _ := sessionName(info.SessionID)
	sb, found, err := rt.sandboxForHandle(ctx, handleName)
	if err != nil || !found {
		t.Fatalf("sandbox lookup: found=%v err=%v", found, err)
	}
	ensureTmux(t, c, sb.ID)

	handle, err := rt.Create(ctx, ports.RuntimeConfig{
		SessionID:     info.SessionID,
		WorkspacePath: info.Path,
		Argv:          []string{"sh", "-c", "echo agent-started; cat"},
		Env:           map[string]string{"AO_SESSION_ID": string(info.SessionID)},
	})
	if err != nil {
		t.Fatalf("runtime create: %v", err)
	}

	waitForOutput(t, rt, handle, "agent-started", 30*time.Second)
	if err := rt.SendMessage(ctx, handle, "ping-round-trip"); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForOutput(t, rt, handle, "ping-round-trip", 30*time.Second)

	// Park → wake: stop kills tmux; Restart must transparently rebuild the
	// terminal under the same handle.
	if err := ws.Park(ctx, info); err != nil {
		t.Fatalf("park: %v", err)
	}
	alive, err := rt.IsAlive(ctx, handle)
	if err != nil || !alive {
		t.Fatalf("parked IsAlive = %v/%v, want true (parked is not dead)", alive, err)
	}
	if _, err := rt.Restart(ctx, handle, ports.RuntimeConfig{
		SessionID:     info.SessionID,
		WorkspacePath: info.Path,
		Argv:          []string{"sh", "-c", "echo agent-restarted; cat"},
	}); err != nil {
		t.Fatalf("restart after park: %v", err)
	}
	waitForOutput(t, rt, handle, "agent-restarted", 30*time.Second)

	if err := rt.Destroy(ctx, handle); err != nil {
		t.Fatalf("runtime destroy: %v", err)
	}
	if err := ws.Destroy(ctx, info); err != nil {
		t.Fatalf("workspace destroy: %v", err)
	}
	if _, found, _ := rt.sandboxForHandle(ctx, handleName); found {
		t.Fatal("sandbox survived workspace destroy")
	}
}

// TestLive_RealAgentSession launches a real agent CLI (argv from
// AO_DAYTONA_AGENT_ARGV, e.g. ["claude","-p","say hello"]) inside the sandbox
// with the caller's credential env injected, and asserts the agent produced
// terminal output — the phase-2 exit-criteria demo. Requires a snapshot with
// the agent CLI preinstalled.
func TestLive_RealAgentSession(t *testing.T) {
	argvJSON := os.Getenv("AO_DAYTONA_AGENT_ARGV")
	if argvJSON == "" {
		t.Skip("AO_DAYTONA_AGENT_ARGV not set; skipping real-agent demo")
	}
	var argv []string
	if err := json.Unmarshal([]byte(argvJSON), &argv); err != nil || len(argv) == 0 {
		t.Fatalf("AO_DAYTONA_AGENT_ARGV must be a JSON string array: %v", err)
	}
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	ws := liveWorkspace(t, c)
	rt, err := New(Options{Client: c, ExecTimeout: 60 * time.Second, StartTimeout: 3 * time.Minute})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	info, err := ws.Create(ctx, ports.WorkspaceConfig{
		ProjectID: "ao-smoke",
		SessionID: domain.SessionID(smokeSessionID(t)),
		Branch:    "ao/smoke/agent",
	})
	if err != nil {
		t.Fatalf("workspace create: %v", err)
	}
	t.Cleanup(func() { _ = ws.ForceDestroy(context.Background(), info) })

	env := map[string]string{"AO_SESSION_ID": string(info.SessionID)}
	if tok := os.Getenv("CLAUDE_CODE_OAUTH_TOKEN"); tok != "" {
		env["CLAUDE_CODE_OAUTH_TOKEN"] = tok
	}
	handle, err := rt.Create(ctx, ports.RuntimeConfig{
		SessionID:     info.SessionID,
		WorkspacePath: info.Path,
		Argv:          argv,
		Env:           env,
	})
	if err != nil {
		t.Fatalf("runtime create: %v", err)
	}
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		out, err := rt.GetOutput(ctx, handle, 200)
		if err == nil && len(strings.TrimSpace(out)) > 0 {
			t.Logf("agent output:\n%s", out)
			return
		}
		time.Sleep(3 * time.Second)
	}
	t.Fatal("agent produced no terminal output within 5m")
}

func waitForOutput(t *testing.T, rt *Runtime, handle ports.RuntimeHandle, marker string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		out, err := rt.GetOutput(context.Background(), handle, 200)
		if err == nil {
			last = out
			if strings.Contains(out, marker) {
				return
			}
		}
		time.Sleep(2 * time.Second)
	}
	t.Fatalf("marker %q not seen in output within %s; last output:\n%s", marker, timeout, last)
}
