package integration

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// realStack wires the REAL components this change touches — the real
// gitworktree adapter against a real on-disk git repo, the real sqlite store,
// and the real lifecycle.Manager — with only the runtime and agent stubbed
// (we cannot launch tmux/agents in CI). This is deliberately NOT the
// stubWorkspace/fakeLCM path: the whole point is to exercise the persistence
// boundary that the in-memory fakes paper over.
type realStack struct {
	store    *sqlite.Store
	mgr      *sessionmanager.Manager
	lcm      *lifecycle.Manager
	rt       *stubRuntime
	repoPath string
	managed  string
}

// newRealGitRepo creates a real git repository with a single commit on `main`
// and returns its absolute path. The path is returned verbatim (the same string
// the RepoResolver hands the adapter), so an in-place WorkspacePath comparison
// is exact regardless of any /tmp symlinking.
func newRealGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("root\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README.md")
	run("commit", "-m", "init")
	return dir
}

// gitOut runs a git command in dir and returns trimmed stdout.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// worktreeCount returns the number of registered git worktrees for the repo.
func worktreeCount(t *testing.T, repo string) int {
	t.Helper()
	out := gitOut(t, repo, "worktree", "list", "--porcelain")
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "worktree ") {
			n++
		}
	}
	return n
}

// newRealStack builds the real-component stack for a project registered with
// the given workspace mode. The gitworktree adapter's RepoResolver maps the
// project id to the real repo root, mirroring the daemon's projectRepoResolver.
func newRealStack(t *testing.T, mode domain.WorkspaceMode) *realStack {
	t.Helper()
	ctx := context.Background()

	repo := newRealGitRepo(t)
	managed := t.TempDir()

	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	if err := store.UpsertProject(ctx, domain.ProjectRecord{
		ID:           "proj",
		Path:         repo,
		RegisteredAt: time.Now(),
		Config: domain.ProjectConfig{
			Workspace:    mode,
			Worker:       domain.RoleOverride{Harness: domain.HarnessClaudeCode},
			Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		},
	}); err != nil {
		t.Fatal(err)
	}

	ws, err := gitworktree.New(gitworktree.Options{
		ManagedRoot:  managed,
		RepoResolver: gitworktree.StaticRepoResolver{"proj": repo},
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
	return &realStack{store: store, mgr: mgr, lcm: lcm, rt: rt, repoPath: repo, managed: managed}
}

// TestInPlace_SpawnPersistsModeThroughSqlite is the load-bearing assertion:
// after an in-place spawn of BOTH roles, the resolved mode must survive a
// round-trip through the REAL sqlite store. The session-manager unit tests miss
// this because their fakeStore keeps the whole SessionMetadata struct in a Go
// map; the sqlite store maps metadata to explicit columns.
func TestInPlace_SpawnPersistsModeThroughSqlite(t *testing.T) {
	for _, kind := range []domain.SessionKind{domain.KindWorker, domain.KindOrchestrator} {
		t.Run(string(kind), func(t *testing.T) {
			ctx := context.Background()
			st := newRealStack(t, domain.WorkspaceModeInPlace)

			headBefore := gitOut(t, st.repoPath, "rev-parse", "HEAD")
			branchBefore := gitOut(t, st.repoPath, "symbolic-ref", "--short", "HEAD")

			sess, err := st.mgr.Spawn(ctx, ports.SpawnConfig{ProjectID: "proj", Kind: kind, Prompt: "do it"})
			if err != nil {
				t.Fatalf("Spawn: %v", err)
			}

			// Returned record: repo root, no branch.
			if sess.Metadata.WorkspacePath != st.repoPath {
				t.Fatalf("WorkspacePath = %q, want repo root %q", sess.Metadata.WorkspacePath, st.repoPath)
			}
			if sess.Metadata.Branch != "" {
				t.Fatalf("Branch = %q, want empty in-place", sess.Metadata.Branch)
			}

			// The mode must be READABLE BACK FROM SQLITE. This is the assertion
			// that the fakeStore-backed unit tests cannot make.
			got, ok, err := st.store.GetSession(ctx, sess.ID)
			if err != nil || !ok {
				t.Fatalf("GetSession ok=%v err=%v", ok, err)
			}
			if got.Metadata.WorkspaceMode != domain.WorkspaceModeInPlace {
				t.Fatalf("persisted WorkspaceMode read back from sqlite = %q, want %q — the mode is dropped at the storage boundary (no workspace_mode column)",
					got.Metadata.WorkspaceMode, domain.WorkspaceModeInPlace)
			}

			// No worktree beyond the repo's own main worktree.
			if n := worktreeCount(t, st.repoPath); n != 1 {
				t.Fatalf("git worktree count = %d, want 1 (in-place creates none)", n)
			}
			// Repo HEAD and checked-out branch unchanged.
			if h := gitOut(t, st.repoPath, "rev-parse", "HEAD"); h != headBefore {
				t.Fatalf("repo HEAD changed: %q -> %q", headBefore, h)
			}
			if b := gitOut(t, st.repoPath, "symbolic-ref", "--short", "HEAD"); b != branchBefore {
				t.Fatalf("repo branch changed: %q -> %q", branchBefore, b)
			}
		})
	}
}

// TestInPlace_RestartRelaunchesAtRepoRoot simulates a daemon restart:
// SaveAndTeardownAll (graceful shutdown) then RestoreAll (startup). An in-place
// session must be torn down with a relaunch marker and then relaunched at the
// repo root, not left dangling. Because the persisted mode is dropped by the
// store, teardown sees a branch-less session it reads as worktree mode and
// SKIPS it, so no marker is written and RestoreAll never relaunches it.
func TestInPlace_RestartRelaunchesAtRepoRoot(t *testing.T) {
	ctx := context.Background()
	st := newRealStack(t, domain.WorkspaceModeInPlace)

	sess, err := st.mgr.Spawn(ctx, ports.SpawnConfig{ProjectID: "proj", Kind: domain.KindWorker, Prompt: "do it"})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	// Make the session resumable so RestoreAll's relaunch would proceed.
	rec, _, _ := st.store.GetSession(ctx, sess.ID)
	rec.Metadata.AgentSessionID = "agent-x"
	if err := st.store.UpdateSession(ctx, rec); err != nil {
		t.Fatal(err)
	}

	createsBefore := st.rt.created

	if err := st.mgr.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll: %v", err)
	}
	// The in-place session must have been torn down with a relaunch marker.
	afterTeardown, _, _ := st.store.GetSession(ctx, sess.ID)
	if !afterTeardown.IsTerminated {
		t.Fatalf("after SaveAndTeardownAll the in-place session must be terminated; it was skipped (mode lost at storage boundary → read as branch-less worktree)")
	}

	if err := st.mgr.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll: %v", err)
	}
	relaunched, _, _ := st.store.GetSession(ctx, sess.ID)
	if relaunched.IsTerminated {
		t.Fatalf("in-place session left terminated after RestoreAll (never relaunched)")
	}
	if st.rt.created <= createsBefore {
		t.Fatalf("runtime.Create not called by RestoreAll (want relaunch); created stayed %d", st.rt.created)
	}
	if relaunched.Metadata.WorkspacePath != st.repoPath {
		t.Fatalf("relaunched cwd = %q, want repo root %q", relaunched.Metadata.WorkspacePath, st.repoPath)
	}
	// Still no daemon worktree for an in-place session.
	if n := worktreeCount(t, st.repoPath); n != 1 {
		t.Fatalf("git worktree count = %d after restart, want 1", n)
	}
}

// TestInPlace_NoRugPull spawns a session in WORKTREE mode, then flips the
// project to in-place and restarts. The pre-flip session must restore into ITS
// OWN worktree with its original branch — a config flip must never relocate an
// already-running session. This path works precisely because the empty
// persisted mode normalizes to worktree.
func TestInPlace_NoRugPull(t *testing.T) {
	ctx := context.Background()
	st := newRealStack(t, domain.WorkspaceModeWorktree)

	sess, err := st.mgr.Spawn(ctx, ports.SpawnConfig{ProjectID: "proj", Kind: domain.KindWorker, Prompt: "do it"})
	if err != nil {
		t.Fatalf("Spawn (worktree): %v", err)
	}
	rec, _, _ := st.store.GetSession(ctx, sess.ID)
	origBranch := rec.Metadata.Branch
	origPath := rec.Metadata.WorkspacePath
	if origBranch == "" || !strings.HasPrefix(origPath, st.managed) {
		t.Fatalf("worktree spawn wrong: branch=%q path=%q managed=%q", origBranch, origPath, st.managed)
	}
	// Make it resumable.
	rec.Metadata.AgentSessionID = "agent-x"
	if err := st.store.UpdateSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	// Second scenario: a REAL worktree session whose persisted WorkspaceMode is
	// then blanked to "" to mimic a row written before the workspace_mode column
	// existed (the true pre-upgrade shape). Unlike a hand-written row pointing at
	// a non-existent path, this one has a real git worktree on disk, so it goes
	// through the FULL teardown (marker + ForceDestroy of the worktree) and
	// restore (worktree re-created, agent relaunched). The empty mode must
	// normalize to worktree on every one of those paths — never in-place.
	legacySess, err := st.mgr.Spawn(ctx, ports.SpawnConfig{ProjectID: "proj", Kind: domain.KindWorker, Prompt: "legacy"})
	if err != nil {
		t.Fatalf("Spawn (legacy worktree): %v", err)
	}
	lrec, _, _ := st.store.GetSession(ctx, legacySess.ID)
	legacyBranch := lrec.Metadata.Branch
	legacyPath := lrec.Metadata.WorkspacePath
	if legacyBranch == "" || !strings.HasPrefix(legacyPath, st.managed) {
		t.Fatalf("legacy worktree spawn wrong: branch=%q path=%q", legacyBranch, legacyPath)
	}
	// Verify the real worktree actually exists on disk before we blank the mode.
	if _, statErr := os.Stat(legacyPath); statErr != nil {
		t.Fatalf("legacy worktree missing on disk: %v", statErr)
	}
	lrec.Metadata.AgentSessionID = "agent-legacy"
	lrec.Metadata.WorkspaceMode = "" // pre-upgrade shape: no persisted mode
	if err := st.store.UpdateSession(ctx, lrec); err != nil {
		t.Fatal(err)
	}
	// The store must persist the empty mode verbatim (not silently default it).
	if chk, _, _ := st.store.GetSession(ctx, legacySess.ID); chk.Metadata.WorkspaceMode != "" {
		t.Fatalf("legacy row workspace_mode read back = %q, want empty (pre-upgrade shape)", chk.Metadata.WorkspaceMode)
	}
	// Before the flip there are two daemon worktrees (proj-1 + legacy) plus the
	// repo's own main worktree.
	if n := worktreeCount(t, st.repoPath); n != 3 {
		t.Fatalf("git worktree count before restart = %d, want 3 (main + 2 sessions)", n)
	}

	// Flip the project to in-place AFTER the sessions exist.
	proj, _, _ := st.store.GetProject(ctx, "proj")
	proj.Config.Workspace = domain.WorkspaceModeInPlace
	if err := st.store.UpsertProject(ctx, proj); err != nil {
		t.Fatal(err)
	}

	// Restart.
	if err := st.mgr.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll: %v", err)
	}
	if err := st.mgr.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll: %v", err)
	}

	// The pre-flip worktree session must still be in its own worktree, not the
	// repo root.
	got, _, _ := st.store.GetSession(ctx, sess.ID)
	if got.Metadata.WorkspacePath == st.repoPath {
		t.Fatalf("RUG PULL: pre-flip worktree session relocated to repo root %q", st.repoPath)
	}
	if got.Metadata.Branch != origBranch {
		t.Fatalf("pre-flip session branch changed %q -> %q", origBranch, got.Metadata.Branch)
	}
	if !strings.HasPrefix(got.Metadata.WorkspacePath, st.managed) {
		t.Fatalf("pre-flip session cwd = %q, want under managed root %q", got.Metadata.WorkspacePath, st.managed)
	}
	// The legacy empty-mode session went through the full teardown+restore. It
	// must be live again, back in ITS OWN worktree with its original branch —
	// never relocated to the repo root by the config flip.
	legacy, _, _ := st.store.GetSession(ctx, legacySess.ID)
	if legacy.IsTerminated {
		t.Fatalf("legacy empty-mode session left terminated after restart (should relaunch into its worktree)")
	}
	if legacy.Metadata.WorkspacePath == st.repoPath {
		t.Fatalf("RUG PULL: legacy empty-mode session relocated to repo root %q", st.repoPath)
	}
	if legacy.Metadata.WorkspacePath != legacyPath {
		t.Fatalf("legacy session cwd = %q, want its own worktree %q", legacy.Metadata.WorkspacePath, legacyPath)
	}
	if legacy.Metadata.Branch != legacyBranch {
		t.Fatalf("legacy session branch changed %q -> %q (rug-pull)", legacyBranch, legacy.Metadata.Branch)
	}
	// Its real worktree must exist again after restore.
	if _, statErr := os.Stat(legacyPath); statErr != nil {
		t.Fatalf("legacy worktree not restored on disk: %v", statErr)
	}
	// Still two daemon worktrees + main after the restart: the flip stranded no
	// session and created no repo-root checkout.
	if n := worktreeCount(t, st.repoPath); n != 3 {
		t.Fatalf("git worktree count after restart = %d, want 3", n)
	}
}

// TestInPlace_CleanupSharesRepoRoot verifies Cleanup on a terminated in-place
// session neither removes the repo root nor reports it Skipped, even when a
// live in-place session shares the same path.
func TestInPlace_CleanupSharesRepoRoot(t *testing.T) {
	ctx := context.Background()
	st := newRealStack(t, domain.WorkspaceModeInPlace)

	// Terminated in-place predecessor.
	dead, err := st.mgr.Spawn(ctx, ports.SpawnConfig{ProjectID: "proj", Kind: domain.KindWorker, Prompt: "dead"})
	if err != nil {
		t.Fatalf("spawn dead: %v", err)
	}
	// Live in-place session sharing the same repo root.
	if _, err := st.mgr.Spawn(ctx, ports.SpawnConfig{ProjectID: "proj", Kind: domain.KindWorker, Prompt: "live"}); err != nil {
		t.Fatalf("spawn live: %v", err)
	}
	// Terminate the predecessor.
	drec, _, _ := st.store.GetSession(ctx, dead.ID)
	drec.IsTerminated = true
	if err := st.store.UpdateSession(ctx, drec); err != nil {
		t.Fatal(err)
	}

	res, err := st.mgr.Cleanup(ctx, "proj")
	if err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	for _, s := range res.Skipped {
		if s.SessionID == dead.ID {
			t.Fatalf("terminated in-place session reported Skipped (%q); the shared repo root must not trip the live-path guard", s.Reason)
		}
	}
	cleaned := false
	for _, id := range res.Cleaned {
		if id == dead.ID {
			cleaned = true
		}
	}
	if !cleaned {
		t.Fatalf("terminated in-place session not reported Cleaned; got cleaned=%v skipped=%v", res.Cleaned, res.Skipped)
	}
	// The repo root and its git dir must still be intact.
	if _, err := os.Stat(filepath.Join(st.repoPath, ".git")); err != nil {
		t.Fatalf("repo .git removed by Cleanup: %v", err)
	}
	if n := worktreeCount(t, st.repoPath); n != 1 {
		t.Fatalf("git worktree count = %d after Cleanup, want 1", n)
	}
}
