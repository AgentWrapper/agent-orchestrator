package daytona

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func newTestWorkspace(t *testing.T, fc *fakeClient) *Workspace {
	t.Helper()
	ws, err := NewWorkspace(WorkspaceOptions{
		Client:   fc,
		Snapshot: "ao-agent-snapshot:1",
		BootEnv:  map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "tok"},
		ResolveRepo: func(context.Context, ports.WorkspaceConfig) (RepoRemote, error) {
			return RepoRemote{URL: "https://github.com/acme/app.git", DefaultBranch: "main"}, nil
		},
		ExecTimeout:   2 * time.Second,
		StartTimeout:  time.Second,
		CreateTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewWorkspace: %v", err)
	}
	return ws
}

func TestWorkspaceCreateProvisionsSandboxAndClone(t *testing.T) {
	fc := newFakeClient()
	// Fresh checkout: the is-inside-work-tree probe must fail first.
	fc.onExec("rev-parse --is-inside-work-tree", ExecResult{ExitCode: 128, Result: "not a git repository"}, nil)
	ws := newTestWorkspace(t, fc)

	info, err := ws.Create(context.Background(), ports.WorkspaceConfig{
		ProjectID:  "proj-1",
		SessionID:  "s1",
		Branch:     "ao/s1/root",
		BaseBranch: "develop",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if info.Path != "/home/daytona/ao/s1" {
		t.Errorf("path = %q", info.Path)
	}
	if info.Branch != "ao/s1/root" {
		t.Errorf("branch = %q", info.Branch)
	}
	if len(fc.createdReqs) != 1 {
		t.Fatalf("created %d sandboxes, want 1", len(fc.createdReqs))
	}
	req := fc.createdReqs[0]
	if req.Snapshot != "ao-agent-snapshot:1" {
		t.Errorf("snapshot = %q", req.Snapshot)
	}
	if req.Labels[LabelSession] != "s1" || req.Labels[LabelProject] != "proj-1" {
		t.Errorf("labels = %v", req.Labels)
	}
	if req.Env["CLAUDE_CODE_OAUTH_TOKEN"] != "tok" {
		t.Errorf("boot env missing injected credential: %v", req.Env)
	}
	if req.AutoStopInterval == nil || *req.AutoStopInterval != defaultAutoStopMinutes {
		t.Errorf("autoStopInterval = %v, want default %d", req.AutoStopInterval, defaultAutoStopMinutes)
	}
	if len(fc.gitClones) != 1 {
		t.Fatalf("git clones = %d, want 1", len(fc.gitClones))
	}
	clone := fc.gitClones[0]
	if clone.URL != "https://github.com/acme/app.git" || clone.Path != "/home/daytona/ao/s1" || clone.Branch != "develop" {
		t.Errorf("clone = %+v", clone)
	}
	if got := fc.commandsMatching("checkout -B 'ao/s1/root'"); len(got) != 1 {
		t.Errorf("expected session branch checkout, commands: %v", fc.commands())
	}
}

func TestWorkspaceCreateDisablesAutoStopWhenNegative(t *testing.T) {
	fc := newFakeClient()
	fc.onExec("rev-parse --is-inside-work-tree", ExecResult{ExitCode: 128}, nil)
	ws, err := NewWorkspace(WorkspaceOptions{
		Client:          fc,
		Snapshot:        "snap",
		AutoStopMinutes: -1,
		ResolveRepo: func(context.Context, ports.WorkspaceConfig) (RepoRemote, error) {
			return RepoRemote{URL: "https://x/r.git"}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewWorkspace: %v", err)
	}
	if _, err := ws.Create(context.Background(), ports.WorkspaceConfig{SessionID: "s1", Branch: "b"}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := fc.createdReqs[0].AutoStopInterval; got == nil || *got != 0 {
		t.Errorf("autoStopInterval = %v, want 0 (disabled)", got)
	}
}

func TestWorkspaceCreateCleansUpOnCloneFailure(t *testing.T) {
	fc := newFakeClient()
	fc.onExec("rev-parse --is-inside-work-tree", ExecResult{ExitCode: 128}, nil)
	fc.gitErr = errors.New("clone denied")
	ws := newTestWorkspace(t, fc)
	_, err := ws.Create(context.Background(), ports.WorkspaceConfig{SessionID: "s1", Branch: "b"})
	if err == nil || !strings.Contains(err.Error(), "clone") {
		t.Fatalf("err = %v, want clone failure", err)
	}
	if len(fc.deleted) != 1 {
		t.Errorf("half-provisioned sandbox must be deleted, deleted=%v", fc.deleted)
	}
}

func TestWorkspaceDestroy(t *testing.T) {
	t.Run("clean checkout deletes the sandbox", func(t *testing.T) {
		fc := newFakeClient()
		id := fc.seedSandbox("s1", StateStarted)
		fc.onExec("status --porcelain", ExecResult{Result: ""}, nil)
		ws := newTestWorkspace(t, fc)
		if err := ws.Destroy(context.Background(), ports.WorkspaceInfo{SessionID: "s1", Path: "/home/daytona/ao/s1"}); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
		if len(fc.deleted) != 1 || fc.deleted[0] != id {
			t.Errorf("deleted = %v, want [%s]", fc.deleted, id)
		}
	})
	t.Run("dirty checkout refuses and keeps the sandbox", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("status --porcelain", ExecResult{Result: " M main.go\n"}, nil)
		ws := newTestWorkspace(t, fc)
		err := ws.Destroy(context.Background(), ports.WorkspaceInfo{SessionID: "s1", Path: "/home/daytona/ao/s1"})
		if !errors.Is(err, ports.ErrWorkspaceDirty) {
			t.Fatalf("err = %v, want ErrWorkspaceDirty", err)
		}
		if len(fc.deleted) != 0 {
			t.Errorf("dirty sandbox must never be deleted, deleted=%v", fc.deleted)
		}
	})
	t.Run("dirty parked sandbox is re-parked after refusal", func(t *testing.T) {
		fc := newFakeClient()
		id := fc.seedSandbox("s1", StateStopped)
		fc.onExec("status --porcelain", ExecResult{Result: " M main.go\n"}, nil)
		ws := newTestWorkspace(t, fc)
		err := ws.Destroy(context.Background(), ports.WorkspaceInfo{SessionID: "s1", Path: "/home/daytona/ao/s1"})
		if !errors.Is(err, ports.ErrWorkspaceDirty) {
			t.Fatalf("err = %v, want ErrWorkspaceDirty", err)
		}
		if len(fc.started) != 1 || len(fc.stopped) != 1 || fc.stopped[0] != id {
			t.Errorf("expected wake for dirty check then re-park; started=%v stopped=%v", fc.started, fc.stopped)
		}
	})
	t.Run("missing sandbox is idempotent success", func(t *testing.T) {
		fc := newFakeClient()
		ws := newTestWorkspace(t, fc)
		if err := ws.Destroy(context.Background(), ports.WorkspaceInfo{SessionID: "s1", Path: "/p"}); err != nil {
			t.Fatalf("Destroy: %v", err)
		}
	})
}

func TestWorkspaceForceDestroySkipsDirtyCheck(t *testing.T) {
	fc := newFakeClient()
	id := fc.seedSandbox("s1", StateStopped)
	ws := newTestWorkspace(t, fc)
	if err := ws.ForceDestroy(context.Background(), ports.WorkspaceInfo{SessionID: "s1", Path: "/p"}); err != nil {
		t.Fatalf("ForceDestroy: %v", err)
	}
	if len(fc.deleted) != 1 || fc.deleted[0] != id {
		t.Errorf("deleted = %v, want [%s]", fc.deleted, id)
	}
	if len(fc.started) != 0 {
		t.Errorf("ForceDestroy must not wake the sandbox, started=%v", fc.started)
	}
}

func TestStashUncommitted(t *testing.T) {
	info := ports.WorkspaceInfo{SessionID: "s1", Path: "/home/daytona/ao/s1"}
	t.Run("clean tree returns empty ref", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("git update-ref", ExecResult{ExitCode: 4}, nil)
		ws := newTestWorkspace(t, fc)
		ref, err := ws.StashUncommitted(context.Background(), info)
		if err != nil || ref != "" {
			t.Fatalf("ref=%q err=%v, want empty nil", ref, err)
		}
	})
	t.Run("stale checkout maps to ErrWorkspaceStale", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("git update-ref", ExecResult{ExitCode: 3}, nil)
		ws := newTestWorkspace(t, fc)
		_, err := ws.StashUncommitted(context.Background(), info)
		if !errors.Is(err, ports.ErrWorkspaceStale) {
			t.Fatalf("err = %v, want ErrWorkspaceStale", err)
		}
	})
	t.Run("dirty tree returns the preserve ref", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		ws := newTestWorkspace(t, fc)
		ref, err := ws.StashUncommitted(context.Background(), info)
		if err != nil {
			t.Fatalf("StashUncommitted: %v", err)
		}
		if ref != "refs/ao/preserved/s1" {
			t.Errorf("ref = %q", ref)
		}
	})
	t.Run("missing sandbox is stale", func(t *testing.T) {
		fc := newFakeClient()
		ws := newTestWorkspace(t, fc)
		_, err := ws.StashUncommitted(context.Background(), info)
		if !errors.Is(err, ports.ErrWorkspaceStale) {
			t.Fatalf("err = %v, want ErrWorkspaceStale", err)
		}
	})
}

func TestApplyPreserved(t *testing.T) {
	info := ports.WorkspaceInfo{SessionID: "s1", Path: "/home/daytona/ao/s1"}
	t.Run("conflict keeps ref and maps sentinel", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		fc.onExec("cherry-pick", ExecResult{ExitCode: 5, Result: "conflict"}, nil)
		ws := newTestWorkspace(t, fc)
		err := ws.ApplyPreserved(context.Background(), info, "refs/ao/preserved/s1")
		if !errors.Is(err, ports.ErrPreservedConflict) {
			t.Fatalf("err = %v, want ErrPreservedConflict", err)
		}
	})
	t.Run("invalid ref is rejected before any exec", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		ws := newTestWorkspace(t, fc)
		err := ws.ApplyPreserved(context.Background(), info, "refs/heads/main; rm -rf /")
		if err == nil || !strings.Contains(err.Error(), "invalid ref") {
			t.Fatalf("err = %v, want invalid ref", err)
		}
		if len(fc.commands()) != 0 {
			t.Errorf("no exec expected for invalid ref, got %v", fc.commands())
		}
	})
	t.Run("clean apply succeeds", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStarted)
		ws := newTestWorkspace(t, fc)
		if err := ws.ApplyPreserved(context.Background(), info, "refs/ao/preserved/s1"); err != nil {
			t.Fatalf("ApplyPreserved: %v", err)
		}
	})
}

func TestAddExcludeIsIdempotentScript(t *testing.T) {
	fc := newFakeClient()
	fc.seedSandbox("s1", StateStarted)
	ws := newTestWorkspace(t, fc)
	if err := ws.AddExclude(context.Background(), ports.WorkspaceInfo{SessionID: "s1", Path: "/p"}, "/.ao-attachments/"); err != nil {
		t.Fatalf("AddExclude: %v", err)
	}
	cmds := fc.commands()
	if len(cmds) != 1 || !strings.Contains(cmds[0], "grep -qxF '/.ao-attachments/'") {
		t.Errorf("commands = %v", cmds)
	}
}

func TestWorkspaceRestore(t *testing.T) {
	t.Run("wakes surviving sandbox and reuses checkout", func(t *testing.T) {
		fc := newFakeClient()
		fc.seedSandbox("s1", StateStopped)
		fc.onExec("rev-parse --abbrev-ref HEAD", ExecResult{Result: "ao/s1/root\n"}, nil)
		ws := newTestWorkspace(t, fc)
		info, err := ws.Restore(context.Background(), ports.WorkspaceConfig{SessionID: "s1", Branch: "ao/s1/root"})
		if err != nil {
			t.Fatalf("Restore: %v", err)
		}
		if len(fc.started) != 1 {
			t.Errorf("expected wake, started=%v", fc.started)
		}
		if info.Branch != "ao/s1/root" || info.Path != "/home/daytona/ao/s1" {
			t.Errorf("info = %+v", info)
		}
		if len(fc.gitClones) != 0 {
			t.Errorf("surviving checkout must not be re-cloned")
		}
	})
	t.Run("deleted sandbox re-provisions from remote", func(t *testing.T) {
		fc := newFakeClient()
		fc.onExec("rev-parse --is-inside-work-tree", ExecResult{ExitCode: 128}, nil)
		ws := newTestWorkspace(t, fc)
		info, err := ws.Restore(context.Background(), ports.WorkspaceConfig{SessionID: "s1", Branch: "ao/s1/root"})
		if err != nil {
			t.Fatalf("Restore: %v", err)
		}
		if len(fc.gitClones) != 1 {
			t.Errorf("expected a fresh clone, clones=%d", len(fc.gitClones))
		}
		if info.Branch != "ao/s1/root" {
			t.Errorf("branch = %q", info.Branch)
		}
	})
}

func TestParkStopsStartedSandbox(t *testing.T) {
	fc := newFakeClient()
	id := fc.seedSandbox("s1", StateStarted)
	ws := newTestWorkspace(t, fc)
	if err := ws.Park(context.Background(), ports.WorkspaceInfo{SessionID: "s1"}); err != nil {
		t.Fatalf("Park: %v", err)
	}
	if len(fc.stopped) != 1 || fc.stopped[0] != id {
		t.Errorf("stopped = %v, want [%s]", fc.stopped, id)
	}
	// Parking an already-parked sandbox is a no-op.
	if err := ws.Park(context.Background(), ports.WorkspaceInfo{SessionID: "s1"}); err != nil {
		t.Fatalf("Park (parked): %v", err)
	}
	if len(fc.stopped) != 1 {
		t.Errorf("second park must no-op, stopped=%v", fc.stopped)
	}
}
