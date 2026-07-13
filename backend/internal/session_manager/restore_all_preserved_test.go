package sessionmanager

import (
	"errors"
	"fmt"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// seedSavedSession seeds one terminated session carrying a shutdown-saved
// marker with a preserved ref — the state RestoreAll replays on boot.
func seedSavedSession(st *fakeStore, id domain.SessionID, ref string) {
	st.sessions[id] = domain.SessionRecord{
		ID:           id,
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/" + string(id), Branch: "ao/" + string(id), AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees[id] = []domain.SessionWorktreeRecord{{
		SessionID: id, RepoName: domain.RootWorkspaceRepoName, PreservedRef: ref, State: "removed",
	}}
}

// TestRestoreAll_KeepsMarkerWhenPreservedApplyFails pins #293 M3 at the manager
// seam: only the intentional conflict sentinel may proceed to relaunch. A
// generic git/IO failure means the agent's preserved work was NOT applied —
// relaunching and then deleting the retry marker silently loses that work. The
// session must stay terminated with its marker intact so the replay can be
// retried.
//
// This fake asserts the manager's half of the contract only. That the PRODUCTION
// adapter actually reports such a failure without the sentinel — it used to wrap
// every non-zero cherry-pick exit as ErrPreservedConflict, which made this test
// vacuous — is pinned by
// TestRestoreAll_KeepsMarkerWhenProductionApplyFailsOperationally.
func TestRestoreAll_KeepsMarkerWhenPreservedApplyFails(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	ws.applyErr = errors.New("git: unable to write index")
	seedSavedSession(st, "mer-1", "refs/ao/preserved/mer-1")

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}

	if rt.created != 0 {
		t.Fatalf("relaunched over unapplied preserved work: runtime.Create called %d times", rt.created)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must stay terminated when its preserved work could not be applied")
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 1 || rows[0].PreservedRef != "refs/ao/preserved/mer-1" {
		t.Fatalf("retry marker was consumed after a failed apply: %#v", rows)
	}
}

// A conflicted apply is intentional and unchanged: the agent is relaunched with
// conflict markers in place and the preserve ref is kept by the adapter.
func TestRestoreAll_RelaunchesOnPreservedConflict(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	// Wrapped exactly as the workspace adapter wraps it.
	ws.applyErr = fmt.Errorf("apply preserved: %w", ports.ErrPreservedConflict)
	seedSavedSession(st, "mer-1", "refs/ao/preserved/mer-1")

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("conflicted apply must still relaunch: runtime.Create called %d times", rt.created)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must be live after a conflicted apply relaunch")
	}
}
