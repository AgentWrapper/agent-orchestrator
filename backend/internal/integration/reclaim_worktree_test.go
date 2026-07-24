package integration

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	prsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pr"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// realWorktreeStack wires the production components that matter for #2811 over a
// real SQLite store and a real git-worktree adapter: the PR service writes facts
// and drives the lifecycle reducer, which (through the SetTerminationReclaimer
// seam) calls the session manager to reclaim the worktree. Only the runtime and
// agent are stubbed — everything the worktree teardown touches is real, so the
// test proves a merged-PR fact actually deletes a worktree directory on disk.
type realWorktreeStack struct {
	store *sqlite.Store
	mgr   *sessionmanager.Manager
	prm   *prsvc.Manager
	ws    *gitworktree.Workspace
	repo  string
}

func newRealWorktreeStack(t *testing.T) *realWorktreeStack {
	t.Helper()
	ctx := context.Background()
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupWorktreeRepo(t, git, tmp)

	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.UpsertProject(ctx, domain.ProjectRecord{
		ID:           "mer",
		Path:         repo,
		RegisteredAt: time.Now(),
		Config: domain.ProjectConfig{
			Worker: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		},
	}); err != nil {
		t.Fatal(err)
	}

	ws, err := gitworktree.New(gitworktree.Options{
		Binary:       git,
		ManagedRoot:  filepath.Join(tmp, "managed"),
		RepoResolver: gitworktree.StaticRepoResolver{"mer": repo},
	})
	if err != nil {
		t.Fatal(err)
	}

	msg := &captureMessenger{}
	lcm := lifecycle.New(store, msg)
	rt := &stubRuntime{}
	mgr := sessionmanager.New(sessionmanager.Deps{
		Runtime:   rt,
		Agents:    stubAgents{},
		Workspace: ws,
		Store:     store,
		Messenger: msg,
		Lifecycle: lcm,
		LookPath:  func(string) (string, error) { return "/usr/bin/true", nil },
	})
	// The production wiring (daemon.startSession) closes this cycle; without it
	// the reducer stays flag-only and the worktree would leak — the #2811 bug.
	lcm.SetTerminationReclaimer(mgr)
	prm := prsvc.New(prsvc.Deps{Writer: store, Lifecycle: lcm})

	return &realWorktreeStack{store: store, mgr: mgr, prm: prm, ws: ws, repo: repo}
}

// seedSessionWithWorktree creates a live worker session row and materializes its
// real worktree on disk, returning the row and the worktree path.
func (st *realWorktreeStack) seedSessionWithWorktree(t *testing.T) (domain.SessionRecord, string) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	rec, err := st.store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	info, err := st.ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "mer", SessionID: rec.ID, Branch: "feature/one"})
	if err != nil {
		t.Fatalf("create worktree: %v", err)
	}
	if _, err := os.Stat(info.Path); err != nil {
		t.Fatalf("worktree not on disk after create: %v", err)
	}
	rec.Metadata = domain.SessionMetadata{WorkspacePath: info.Path, Branch: info.Branch, RuntimeHandleID: "h1"}
	if err := st.store.UpdateSession(ctx, rec); err != nil {
		t.Fatalf("update session metadata: %v", err)
	}
	return rec, info.Path
}

// A merged PR observed for a session with no open PRs must terminate the session
// AND physically reclaim its worktree from disk — the whole fix for #2811,
// exercised through the real PR service, lifecycle reducer, session manager, and
// git-worktree adapter.
func TestMergeObservationReclaimsRealWorktree(t *testing.T) {
	ctx := context.Background()
	st := newRealWorktreeStack(t)
	rec, wsPath := st.seedSessionWithWorktree(t)

	if err := st.prm.ApplyObservation(ctx, rec.ID, ports.PRObservation{Fetched: true, URL: "pr1", Number: 1, Merged: true}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := st.store.GetSession(ctx, rec.ID)
	if err != nil || !ok {
		t.Fatalf("get session: ok=%v err=%v", ok, err)
	}
	if !got.IsTerminated {
		t.Fatalf("merged PR should terminate session, got %+v", got)
	}
	if _, err := os.Stat(wsPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("worktree should be reclaimed from disk, stat err = %v (want not-exist)", err)
	}
}

// A worktree with uncommitted work is preserved, never force-removed (the
// data-safety hard rule): the session still terminates on merge, but its
// worktree survives on disk for the user to recover.
func TestMergeObservationPreservesDirtyRealWorktree(t *testing.T) {
	ctx := context.Background()
	st := newRealWorktreeStack(t)
	rec, wsPath := st.seedSessionWithWorktree(t)

	// Dirty the worktree: any status-visible change makes `git worktree remove`
	// refuse, which the reclaim maps to ErrWorkspaceDirty and preserves.
	if err := os.WriteFile(filepath.Join(wsPath, "uncommitted.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatalf("dirty worktree: %v", err)
	}

	if err := st.prm.ApplyObservation(ctx, rec.ID, ports.PRObservation{Fetched: true, URL: "pr1", Number: 1, Merged: true}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := st.store.GetSession(ctx, rec.ID)
	if err != nil || !ok {
		t.Fatalf("get session: ok=%v err=%v", ok, err)
	}
	if !got.IsTerminated {
		t.Fatalf("merged PR should terminate session even when dirty, got %+v", got)
	}
	if _, err := os.Stat(wsPath); err != nil {
		t.Fatalf("dirty worktree must be preserved, stat err = %v (want it to still exist)", err)
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

// setupWorktreeRepo builds a bare origin plus a clone with a committed main
// branch and a local git identity, the shape the gitworktree adapter expects to
// add worktrees from. It mirrors the gitworktree package's own integration
// setup, which lives in an unexported test helper there.
func setupWorktreeRepo(t *testing.T, git, tmp string) string {
	t.Helper()
	origin := filepath.Join(tmp, "origin.git")
	seed := filepath.Join(tmp, "seed")
	repo := filepath.Join(tmp, "repo")
	runGitIn(t, git, tmp, "init", "--bare", origin)
	runGitIn(t, git, tmp, "init", seed)
	runGitIn(t, git, seed, "config", "user.email", "ao@example.com")
	runGitIn(t, git, seed, "config", "user.name", "Ao Agents")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	runGitIn(t, git, seed, "add", "README.md")
	runGitIn(t, git, seed, "commit", "-m", "seed")
	runGitIn(t, git, seed, "branch", "-M", "main")
	runGitIn(t, git, seed, "remote", "add", "origin", origin)
	runGitIn(t, git, seed, "push", "-u", "origin", "main")
	runGitIn(t, git, tmp, "clone", origin, repo)
	runGitIn(t, git, repo, "config", "user.email", "ao@example.com")
	runGitIn(t, git, repo, "config", "user.name", "Ao Agents")
	runGitIn(t, git, repo, "checkout", "main")
	return repo
}

func runGitIn(t *testing.T, git, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(git, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
