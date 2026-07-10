package lifecycle

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestMarkSpawned_PersistsWorkspaceMode guards the metadata merge against
// silently dropping WorkspaceMode. mergeMetadata copies a fixed list of fields;
// a field missing from that list is discarded on its way to the store, so an
// in-place session would persist mode "" — which normalizes back to worktree on
// the next restore and relocates the session into a worktree it never had.
func TestMarkSpawned_PersistsWorkspaceMode(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", IsTerminated: true}

	metadata := domain.SessionMetadata{
		WorkspacePath:   "/repo",
		WorkspaceMode:   domain.WorkspaceModeInPlace,
		RuntimeHandleID: "h1",
	}
	if err := m.MarkSpawned(ctx, "mer-1", metadata); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Metadata.WorkspaceMode; got != domain.WorkspaceModeInPlace {
		t.Fatalf("persisted WorkspaceMode = %q, want %q", got, domain.WorkspaceModeInPlace)
	}
}

// TestMarkSpawned_UnknownWorkspaceModeKeepsBase locks the zero-value semantics:
// an empty mode is meaningful (it reads as worktree for every session spawned
// before the field existed), so it must never overwrite a mode already on the
// record.
func TestMarkSpawned_UnknownWorkspaceModeKeepsBase(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspaceMode: domain.WorkspaceModeInPlace},
	}

	if err := m.MarkSpawned(ctx, "mer-1", domain.SessionMetadata{RuntimeHandleID: "h1"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Metadata.WorkspaceMode; got != domain.WorkspaceModeInPlace {
		t.Fatalf("WorkspaceMode = %q after empty-mode merge, want it preserved as %q", got, domain.WorkspaceModeInPlace)
	}
}

// TestMarkSwitched_CarriesWorkspaceMode guards the harness-switch path for the
// same reason MarkSwitched already carries WorkspacePath and Branch: losing the
// mode would demote an in-place session to worktree on the next restore.
func TestMarkSwitched_CarriesWorkspaceMode(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessClaudeCode}

	metadata := domain.SessionMetadata{
		WorkspacePath:   "/repo",
		WorkspaceMode:   domain.WorkspaceModeInPlace,
		RuntimeHandleID: "h2",
	}
	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, metadata); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Metadata.WorkspaceMode; got != domain.WorkspaceModeInPlace {
		t.Fatalf("WorkspaceMode after switch = %q, want %q", got, domain.WorkspaceModeInPlace)
	}
}

// TestMarkSwitched_UnknownWorkspaceModeKeepsBase mirrors the MarkSpawned case:
// a switch that supplies no mode leaves the persisted one alone.
func TestMarkSwitched_UnknownWorkspaceModeKeepsBase(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Harness:   domain.HarnessClaudeCode,
		Metadata:  domain.SessionMetadata{WorkspaceMode: domain.WorkspaceModeWorktree, Branch: "b"},
	}

	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, domain.SessionMetadata{RuntimeHandleID: "h2"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Metadata.WorkspaceMode; got != domain.WorkspaceModeWorktree {
		t.Fatalf("WorkspaceMode after switch = %q, want it preserved as %q", got, domain.WorkspaceModeWorktree)
	}
}
