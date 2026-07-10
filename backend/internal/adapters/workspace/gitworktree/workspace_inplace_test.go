package gitworktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// gitOut runs git in dir and returns its trimmed stdout.
func gitOut(t *testing.T, git, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(git, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out))
}

// TestWorkspaceIntegrationInPlaceUsesRepoRoot is the reproduction for GH #174:
// a session configured for in-place mode must start at the project's repo root.
// The daemon must not add a worktree and must not check out a branch there —
// the shared root is read-only ground truth owned by the operator's SDLC skills.
func TestWorkspaceIntegrationInPlaceUsesRepoRoot(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()

	headBefore := gitOut(t, git, repo, "rev-parse", "HEAD")
	branchBefore := gitOut(t, git, repo, "rev-parse", "--abbrev-ref", "HEAD")

	cfg := ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Mode: domain.WorkspaceModeInPlace}
	info, err := ws.Create(ctx, cfg)
	if err != nil {
		t.Fatalf("create in-place: %v", err)
	}

	// 1. The session's cwd IS the repo root.
	if info.Path != repo {
		t.Fatalf("in-place path = %q, want repo root %q", info.Path, repo)
	}
	// 2. No branch was created or checked out for the session.
	if info.Branch != "" {
		t.Fatalf("in-place branch = %q, want empty (daemon must not own a branch)", info.Branch)
	}
	if info.Mode != domain.WorkspaceModeInPlace {
		t.Fatalf("info.Mode = %q, want %q", info.Mode, domain.WorkspaceModeInPlace)
	}
	// 3. The repo root is untouched: same HEAD, same checked-out branch.
	if got := gitOut(t, git, repo, "rev-parse", "HEAD"); got != headBefore {
		t.Fatalf("repo HEAD moved: %q -> %q", headBefore, got)
	}
	if got := gitOut(t, git, repo, "rev-parse", "--abbrev-ref", "HEAD"); got != branchBefore {
		t.Fatalf("repo branch switched: %q -> %q", branchBefore, got)
	}
	// 4. No linked worktree was registered, and nothing was written under the
	//    managed root — the daemon-worktree layer is entirely absent.
	if list := gitOut(t, git, repo, "worktree", "list"); strings.Count(list, "\n") != 0 {
		t.Fatalf("expected only the main worktree, got:\n%s", list)
	}
	if _, err := os.Stat(filepath.Join(ws.managedRoot, "proj", "sess")); !os.IsNotExist(err) {
		t.Fatalf("managed worktree dir exists for in-place session (stat err = %v)", err)
	}

	// 5. Restore is idempotent and lands at the same place after a daemon restart.
	restored, err := ws.Restore(ctx, cfg)
	if err != nil {
		t.Fatalf("restore in-place: %v", err)
	}
	if restored.Path != repo || restored.Branch != "" {
		t.Fatalf("restored = %#v, want path %q and no branch", restored, repo)
	}

	// 6. Teardown never removes or mutates the operator's repo root.
	if err := ws.Destroy(ctx, info); err != nil {
		t.Fatalf("destroy in-place: %v", err)
	}
	if err := ws.ForceDestroy(ctx, info); err != nil {
		t.Fatalf("force destroy in-place: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, "README.md")); err != nil {
		t.Fatalf("repo root damaged by teardown: %v", err)
	}

	// 7. StashUncommitted never builds a preserve ref from the shared root:
	//    it is not the session's private tree.
	if err := os.WriteFile(filepath.Join(repo, "operator-wip.txt"), []byte("in flight"), 0o644); err != nil {
		t.Fatalf("write operator wip: %v", err)
	}
	ref, err := ws.StashUncommitted(ctx, info)
	if err != nil {
		t.Fatalf("stash in-place: %v", err)
	}
	if ref != "" {
		t.Fatalf("stash produced ref %q for in-place session; the shared root must never be captured", ref)
	}
	if _, err := os.Stat(filepath.Join(repo, "operator-wip.txt")); err != nil {
		t.Fatalf("operator's uncommitted file disturbed: %v", err)
	}
}
