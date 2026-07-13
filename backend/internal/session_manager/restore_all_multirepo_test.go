package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// perRepoApplyWorkspace fails ApplyPreserved for ONE repo of a workspace project
// and applies the rest cleanly — the partial-success shape a multi-repo restore
// hits when, say, one repo's disk write fails.
type perRepoApplyWorkspace struct {
	*fakeWorkspace
	failPath string
	failErr  error
}

func (w *perRepoApplyWorkspace) ApplyPreserved(ctx context.Context, info ports.WorkspaceInfo, ref string) error {
	if info.Path == w.failPath {
		return w.failErr
	}
	return w.fakeWorkspace.ApplyPreserved(ctx, info, ref)
}

// TestRestoreAll_MultiRepoClearsAppliedRefOnPartialFailure pins #293 M6: when one
// repo of a workspace project applies cleanly and a later one fails, the clean
// repo's preserve ref has ALREADY been deleted from git by ApplyPreserved — but
// its DB row still names it. Leaving that stale ref in the row poisons the retry
// marker: the next boot resolves the deleted ref first, fails, and abandons the
// whole restore before it ever retries the repo that actually needs replaying.
//
// Each repo's row must lose its PreservedRef the moment that repo applies, while
// the overall marker survives for the repos that still need it.
func TestRestoreAll_MultiRepoClearsAppliedRefOnPartialFailure(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{
		ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents(),
	}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	rt := &fakeRuntime{}
	ws := &perRepoApplyWorkspace{
		fakeWorkspace: &fakeWorkspace{},
		failPath:      "/ws/mer-1/api",
		failErr:       errors.New("git: unable to write index"),
	}
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
	})

	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1", PreservedRef: "refs/ao/preserved/mer-1", State: "removed"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api", PreservedRef: "refs/ao/preserved/mer-1-api", State: "removed"},
	}

	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}

	if rt.created != 0 {
		t.Fatalf("relaunched over unapplied preserved work: runtime.Create called %d times", rt.created)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must stay terminated when a repo's preserved work could not be applied")
	}
	rows := map[string]domain.SessionWorktreeRecord{}
	for _, row := range st.worktrees["mer-1"] {
		rows[row.RepoName] = row
	}
	if got := rows[domain.RootWorkspaceRepoName].PreservedRef; got != "" {
		t.Fatalf("root repo applied cleanly but its row still names the (now deleted) ref %q — the next boot will fail resolving it and never retry api", got)
	}
	if got := rows["api"].PreservedRef; got != "refs/ao/preserved/mer-1-api" {
		t.Fatalf("api row's retry marker = %q, want it retained for the retry", got)
	}
}
