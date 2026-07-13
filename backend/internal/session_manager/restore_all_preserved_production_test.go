package sessionmanager

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// productionApplyWorkspace is the manager's fake workspace with ONE real method:
// ApplyPreserved is the production gitworktree adapter, running real git against
// a real worktree. The M3 guard keys on how that adapter CLASSIFIES a failed
// replay (ErrPreservedConflict = intentional, anything else = work not applied),
// so a fake that invents its own error proves nothing about production; this
// wrapper puts the real classifier under the manager.
type productionApplyWorkspace struct {
	*fakeWorkspace
	real *gitworktree.Workspace
	info ports.WorkspaceInfo
}

func (w *productionApplyWorkspace) ApplyPreserved(ctx context.Context, _ ports.WorkspaceInfo, ref string) error {
	return w.real.ApplyPreserved(ctx, w.info, ref)
}

// TestRestoreAll_KeepsMarkerWhenProductionApplyFailsOperationally is the M3
// regression test driven through the PRODUCTION classification path: a real
// worktree, a real preserve ref, and a git whose merge step fails the way an
// operational problem fails (non-zero exit, nothing merged, no unmerged index
// entries — disk full, permission denied, unwritable index, cancelled context).
//
// The adapter must NOT call that a conflict, and RestoreAll must therefore leave
// the session terminated with its retry marker intact instead of relaunching the
// agent over unapplied work and consuming the marker.
func TestRestoreAll_KeepsMarkerWhenProductionApplyFailsOperationally(t *testing.T) {
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not found")
	}
	tmp := t.TempDir()
	worktree, ref := seedPreservedWorktree(t, git, tmp)

	// Same production adapter, same worktree — but its git fails the merge step.
	brokenWS, err := gitworktree.New(gitworktree.Options{
		Binary:       failingCherryPickGit(t, git, tmp),
		ManagedRoot:  filepath.Join(tmp, "managed"),
		RepoResolver: gitworktree.StaticRepoResolver{"mer": filepath.Join(tmp, "repo")},
	})
	if err != nil {
		t.Fatalf("new broken workspace: %v", err)
	}

	info := ports.WorkspaceInfo{Path: worktree, Branch: "ao/mer-1", Mode: domain.WorkspaceModeWorktree}
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &productionApplyWorkspace{fakeWorkspace: &fakeWorkspace{path: worktree}, real: brokenWS, info: info}
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
	})
	seedSavedSession(st, "mer-1", ref)

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}

	if rt.created != 0 {
		t.Fatalf("relaunched over preserved work the production adapter could not apply: runtime.Create called %d times", rt.created)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must stay terminated when its preserved work could not be applied")
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 1 || rows[0].PreservedRef != ref {
		t.Fatalf("retry marker was consumed after a failed apply: %#v", rows)
	}
}

// seedPreservedWorktree builds a real git repo + worktree with uncommitted work
// captured into a preserve ref by the production adapter, and returns the
// worktree path and the ref.
func seedPreservedWorktree(t *testing.T, git, tmp string) (string, string) {
	t.Helper()
	repo := filepath.Join(tmp, "repo")
	runGitCmd(t, git, tmp, "init", repo)
	runGitCmd(t, git, repo, "config", "user.email", "ao@example.com")
	runGitCmd(t, git, repo, "config", "user.name", "Ao Agents")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write seed README: %v", err)
	}
	runGitCmd(t, git, repo, "add", "README.md")
	runGitCmd(t, git, repo, "commit", "-m", "seed")

	worktree := filepath.Join(tmp, "wt")
	runGitCmd(t, git, repo, "worktree", "add", "-b", "ao/mer-1", worktree)
	// The agent's uncommitted work — what the preserve ref must carry.
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("agent work\n"), 0o644); err != nil {
		t.Fatalf("write agent work: %v", err)
	}

	ws, err := gitworktree.New(gitworktree.Options{
		Binary:       git,
		ManagedRoot:  filepath.Join(tmp, "managed"),
		RepoResolver: gitworktree.StaticRepoResolver{"mer": repo},
	})
	if err != nil {
		t.Fatalf("new workspace: %v", err)
	}
	ref, err := ws.StashUncommitted(context.Background(), ports.WorkspaceInfo{
		Path: worktree, Branch: "ao/mer-1", Mode: domain.WorkspaceModeWorktree, SessionID: "mer-1",
	})
	if err != nil {
		t.Fatalf("StashUncommitted: %v", err)
	}
	if ref == "" {
		t.Fatal("StashUncommitted returned an empty ref for a dirty worktree")
	}
	// Drop the in-flight edit, as tearing the worktree down and re-adding it does
	// on the real restore path: the preserved work is genuinely missing from the
	// worktree now, so a failed replay really does lose it.
	runGitCmd(t, git, worktree, "checkout", "--", "README.md")
	return worktree, ref
}

// failingCherryPickGit writes a git wrapper that proxies every subcommand to the
// real git EXCEPT cherry-pick, which fails the way an operational problem fails:
// non-zero exit, nothing merged, and no unmerged entries left in the index.
func failingCherryPickGit(t *testing.T, realGit, dir string) string {
	t.Helper()
	script := filepath.Join(dir, "git-cherry-pick-fails")
	body := "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"cherry-pick\" ]; then\n    echo 'fatal: Unable to write new index file' >&2\n    exit 128\n  fi\ndone\nexec " + realGit + " \"$@\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write git wrapper: %v", err)
	}
	return script
}

func runGitCmd(t *testing.T, git, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(git, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
