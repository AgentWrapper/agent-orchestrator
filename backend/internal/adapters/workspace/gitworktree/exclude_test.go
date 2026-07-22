package gitworktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAddExcludeWritesAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	// A managed worktree path must exist and resolve inside the managed root.
	wtPath := filepath.Join(ws.managedRoot, "proj", "worker", "proj-1")
	if err := os.MkdirAll(wtPath, 0o750); err != nil {
		t.Fatalf("mkdir worktree: %v", err)
	}
	// The per-worktree git dir is resolved via `git rev-parse --git-dir`; stub it.
	gitDir := filepath.Join(root, "gitdir")
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), "rev-parse --git-dir") {
			return []byte(gitDir + "\n"), nil
		}
		t.Fatalf("unexpected git invocation: %v", args)
		return nil, nil
	}

	info := ports.WorkspaceInfo{Path: wtPath, SessionID: "proj-1", ProjectID: "proj"}
	pattern := "/.ao/attachments/"
	if err := ws.AddExclude(context.Background(), info, pattern); err != nil {
		t.Fatalf("AddExclude: %v", err)
	}

	excludePath := filepath.Join(gitDir, "info", "exclude")
	data, err := os.ReadFile(excludePath)
	if err != nil {
		t.Fatalf("read exclude: %v", err)
	}
	if !strings.Contains(string(data), pattern) {
		t.Errorf("exclude missing pattern: %q", data)
	}

	// Calling again must not duplicate the entry.
	if err := ws.AddExclude(context.Background(), info, pattern); err != nil {
		t.Fatalf("AddExclude (repeat): %v", err)
	}
	data, err = os.ReadFile(excludePath)
	if err != nil {
		t.Fatalf("read exclude: %v", err)
	}
	if got := strings.Count(string(data), pattern); got != 1 {
		t.Errorf("pattern written %d times, want 1: %q", got, data)
	}
}

func TestAddExcludeRejectsUnmanagedPath(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	info := ports.WorkspaceInfo{Path: "/etc", SessionID: "proj-1"}
	if err := ws.AddExclude(context.Background(), info, "/x/"); err == nil {
		t.Fatal("expected AddExclude to reject a path outside the managed root")
	}
}

func TestAddExcludeNoPatternsIsNoop(t *testing.T) {
	ws, err := New(Options{ManagedRoot: t.TempDir(), RepoResolver: StaticRepoResolver{"proj": t.TempDir()}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ws.run = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		t.Fatal("run must not be called when there are no patterns")
		return nil, nil
	}
	if err := ws.AddExclude(context.Background(), ports.WorkspaceInfo{Path: "/whatever"}); err != nil {
		t.Fatalf("AddExclude with no patterns: %v", err)
	}
}
