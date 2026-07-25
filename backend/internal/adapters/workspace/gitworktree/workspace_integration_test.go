package gitworktree

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestWorkspaceIntegrationCreateRestoreDestroy(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/one"}

	info, err := ws.Create(ctx, cfg)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if info.Path != filepath.Join(ws.managedRoot, "proj", "sess") || info.Branch != cfg.Branch || info.SessionID != cfg.SessionID || info.ProjectID != cfg.ProjectID {
		t.Fatalf("info = %#v", info)
	}
	if _, err := os.Stat(filepath.Join(info.Path, "README.md")); err != nil {
		t.Fatalf("created worktree missing seed file: %v", err)
	}

	restored, err := ws.Restore(ctx, cfg)
	if err != nil {
		t.Fatalf("restore registered: %v", err)
	}
	if restored.Path != info.Path || restored.Branch != cfg.Branch {
		t.Fatalf("restored = %#v", restored)
	}

	if err := ws.Destroy(ctx, info); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	if _, err := os.Stat(info.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("path after destroy stat err = %v, want not exist", err)
	}

	restored, err = ws.Restore(ctx, cfg)
	if err != nil {
		t.Fatalf("restore after destroy: %v", err)
	}
	if restored.Path != info.Path || restored.Branch != cfg.Branch {
		t.Fatalf("restored after destroy = %#v", restored)
	}
	if err := ws.Destroy(ctx, restored); err != nil {
		t.Fatalf("destroy restored: %v", err)
	}
}

func TestWorkspaceIntegrationDestroyRefusesLockedWorktree(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	info, err := ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/lock"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	runGit(t, git, repo, "worktree", "lock", info.Path)

	err = ws.Destroy(ctx, info)
	if err == nil || !strings.Contains(err.Error(), "still registered") {
		t.Fatalf("destroy locked error = %v, want still registered refusal", err)
	}
	if _, statErr := os.Stat(filepath.Join(info.Path, "README.md")); statErr != nil {
		t.Fatalf("locked worktree was not preserved: %v", statErr)
	}

	runGit(t, git, repo, "worktree", "unlock", info.Path)
	if err := ws.Destroy(ctx, info); err != nil {
		t.Fatalf("destroy after unlock: %v", err)
	}
}

// TestWorkspaceIntegrationDestroyDirtyWorktree proves the two halves of the
// dirty-teardown contract against real git:
//
//  1. A worktree whose only untracked files are covered by a self-ignoring
//     .gitignore (the shape agent adapters install for their hook files) is
//     clean in git's eyes, so Destroy succeeds without --force.
//  2. Real uncommitted work makes Destroy refuse with ports.ErrWorkspaceDirty
//     and preserves the worktree.
func TestWorkspaceIntegrationDestroyDirtyWorktree(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	info, err := ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/dirty"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// AO-managed hook files behind a self-ignoring .gitignore: invisible to git
	// status, so they must not block teardown.
	hookDir := filepath.Join(info.Path, ".codex")
	if err := os.MkdirAll(hookDir, 0o750); err != nil {
		t.Fatalf("mkdir hook dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(hookDir, "hooks.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("write hooks.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(hookDir, ".gitignore"), []byte(".gitignore\nhooks.json\n"), 0o600); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}

	// Real agent work must keep blocking teardown, typed as ErrWorkspaceDirty.
	wip := filepath.Join(info.Path, "wip.txt")
	if err := os.WriteFile(wip, []byte("uncommitted\n"), 0o600); err != nil {
		t.Fatalf("write wip: %v", err)
	}
	err = ws.Destroy(ctx, info)
	if !errors.Is(err, ports.ErrWorkspaceDirty) {
		t.Fatalf("destroy dirty error = %v, want ports.ErrWorkspaceDirty", err)
	}
	if _, statErr := os.Stat(wip); statErr != nil {
		t.Fatalf("dirty worktree was not preserved: %v", statErr)
	}

	// With the real work gone, only the ignored AO files remain — git considers
	// the worktree clean and Destroy succeeds without --force.
	if err := os.Remove(wip); err != nil {
		t.Fatalf("remove wip: %v", err)
	}
	if err := ws.Destroy(ctx, info); err != nil {
		t.Fatalf("destroy with ignored-only files: %v", err)
	}
	if _, err := os.Stat(info.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("path after destroy stat err = %v, want not exist", err)
	}
}

// TestWorkspaceIntegrationCreateInRemotelessRepo guards the BRANCH_NOT_FETCHED
// regression: a repo with no remote configured must still spawn worktrees for
// new branches by basing them on the local default-branch head
// (refs/heads/main) once no origin/* candidate resolves.
func TestWorkspaceIntegrationCreateInRemotelessRepo(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := filepath.Join(tmp, "repo")
	run(t, git, "init", repo)
	runGit(t, git, repo, "config", "core.autocrlf", "false")
	runGit(t, git, repo, "config", "user.email", "ao@example.com")
	runGit(t, git, repo, "config", "user.name", "Ao Agents")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	runGit(t, git, repo, "add", "README.md")
	runGit(t, git, repo, "commit", "-m", "seed")
	runGit(t, git, repo, "branch", "-M", "main")

	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	info, err := ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/remoteless"})
	if err != nil {
		t.Fatalf("create in remoteless repo: %v", err)
	}
	if _, err := os.Stat(filepath.Join(info.Path, "README.md")); err != nil {
		t.Fatalf("created worktree missing seed file: %v", err)
	}
	if err := ws.Destroy(ctx, info); err != nil {
		t.Fatalf("destroy: %v", err)
	}
}

func requireGit(t *testing.T) string {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not found")
	}
	return git
}

func setupOriginClone(t *testing.T, git, tmp string) string {
	t.Helper()
	origin := filepath.Join(tmp, "origin.git")
	seed := filepath.Join(tmp, "seed")
	repo := filepath.Join(tmp, "repo")
	run(t, git, "init", "--bare", origin)
	run(t, git, "init", seed)
	runGit(t, git, seed, "config", "core.autocrlf", "false")
	runGit(t, git, seed, "config", "user.email", "ao@example.com")
	runGit(t, git, seed, "config", "user.name", "Ao Agents")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	runGit(t, git, seed, "add", "README.md")
	runGit(t, git, seed, "commit", "-m", "seed")
	runGit(t, git, seed, "branch", "-M", "main")
	runGit(t, git, seed, "remote", "add", "origin", origin)
	runGit(t, git, seed, "push", "-u", "origin", "main")
	run(t, git, "clone", origin, repo)
	runGit(t, git, repo, "config", "core.autocrlf", "false")
	// A clone does not copy the seed's local identity, and CI runners have no
	// global git identity to fall back on, so commit/commit-tree in this repo's
	// worktrees would fail with "empty ident name". Set it on the clone; worktrees
	// inherit the common dir config.
	runGit(t, git, repo, "config", "user.email", "ao@example.com")
	runGit(t, git, repo, "config", "user.name", "Ao Agents")
	runGit(t, git, repo, "checkout", "main")
	runGit(t, git, repo, "reset", "--hard", "HEAD")
	return repo
}

func runGit(t *testing.T, git, dir string, args ...string) {
	t.Helper()
	run(t, git, append([]string{"-C", dir}, args...)...)
}

func run(t *testing.T, binary string, args ...string) {
	t.Helper()
	cmd := exec.Command(binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", binary, strings.Join(args, " "), err, out)
	}
}
