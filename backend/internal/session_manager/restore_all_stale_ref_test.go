package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// refDeletingWorkspace models the adapter's real contract: a clean ApplyPreserved
// DELETES the preserve ref from git, so replaying the same ref a second time
// cannot resolve it. That is what the production adapter reports as
// ErrPreservedRefMissing.
type refDeletingWorkspace struct {
	*fakeWorkspace
	deleted map[string]bool
}

func (w *refDeletingWorkspace) ApplyPreserved(ctx context.Context, info ports.WorkspaceInfo, ref string) error {
	if w.deleted[ref] {
		return fmt.Errorf("%w: %s", ports.ErrPreservedRefMissing, ref)
	}
	if err := w.fakeWorkspace.ApplyPreserved(ctx, info, ref); err != nil {
		return err
	}
	w.deleted[ref] = true
	return nil
}

// TestRestoreAll_RecoversFromCrashBetweenRefDeleteAndRowWrite pins #293 M6 cycle
// 2: ApplyPreserved deletes the git ref BEFORE the row that names it is cleared,
// so a transient failure of that DB write (SQLite busy, IO error, a crash)
// leaves the row pointing at a ref that no longer exists. On the next boot the
// restore resolves that ref first, fails, and abandons the session before it
// ever reaches the repo whose work IS still preserved — the exact poisoned
// marker the per-repo clear was added to remove, now with no way out.
//
// A recorded ref that git no longer has is work that already landed. Treat it as
// consumed, clear the row, and carry on with the rest of the restore.
func TestRestoreAll_RecoversFromCrashBetweenRefDeleteAndRowWrite(t *testing.T) {
	st := newFakeStore()
	st.projects["stale"] = domain.ProjectRecord{
		ID: "stale", Path: "/repo/stale", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents(),
	}
	st.workspaceRepo["stale"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	rt := &fakeRuntime{}
	ws := &refDeletingWorkspace{fakeWorkspace: &fakeWorkspace{}, deleted: map[string]bool{}}
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
	})

	st.sessions["stale-1"] = domain.SessionRecord{
		ID:           "stale-1",
		ProjectID:    "stale",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/stale-1", Branch: "ao/stale-1", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["stale-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "stale-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/stale-1", WorktreePath: "/ws/stale-1", PreservedRef: "refs/ao/preserved/stale-1", State: "removed"},
		{SessionID: "stale-1", RepoName: "api", Branch: "ao/stale-1", WorktreePath: "/ws/stale-1/api", PreservedRef: "refs/ao/preserved/stale-1-api", State: "removed"},
	}

	// Boot 1: the root repo applies (its ref is gone from git) and the row write
	// that would record that fails transiently. The restore stops with the root
	// row still naming the deleted ref.
	st.upsertWTErr = errors.New("database is locked")
	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatalf("RestoreAll (boot 1) err = %v", err)
	}
	if rt.created != 0 {
		t.Fatalf("relaunched despite an incomplete preserved restore: runtime.Create called %d times", rt.created)
	}
	rows := worktreeRowsByRepo(st, "stale-1")
	if got := rows[domain.RootWorkspaceRepoName].PreservedRef; got != "refs/ao/preserved/stale-1" {
		t.Fatalf("setup: root row PreservedRef = %q, want the stale ref the failed write left behind", got)
	}

	// Boot 2: the store is healthy again. The root row still names a ref git no
	// longer has — the restore must recognise it as already applied, clear it, and
	// go on to replay the repo that IS still preserved.
	st.upsertWTErr = nil
	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatalf("RestoreAll (boot 2) err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("session was not relaunched after the stale ref was reconciled: runtime.Create called %d times", rt.created)
	}
	if st.sessions["stale-1"].IsTerminated {
		t.Fatal("session is still terminated after a completed restore")
	}
	rows = worktreeRowsByRepo(st, "stale-1")
	for repo, row := range rows {
		if row.PreservedRef != "" {
			t.Fatalf("repo %q still names preserved ref %q after a completed restore", repo, row.PreservedRef)
		}
	}
}

func worktreeRowsByRepo(st *fakeStore, id domain.SessionID) map[string]domain.SessionWorktreeRecord {
	rows := map[string]domain.SessionWorktreeRecord{}
	for _, row := range st.worktrees[id] {
		rows[row.RepoName] = row
	}
	return rows
}
