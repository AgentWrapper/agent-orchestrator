package sessionmanager

import (
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adoptedTree = "/pipelines/run-a/workspace"

// A spawn that names an existing tree runs in that tree: no worktree is
// created, and the record says the tree is adopted so no teardown path treats
// it as the session's own to remove.
func TestSpawn_AdoptsProvidedWorkspace(t *testing.T) {
	m, st, rt, ws := newManager()
	s, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:     "mer",
		Kind:          domain.KindWorker,
		Harness:       domain.HarnessClaudeCode,
		Prompt:        "write a file",
		WorkspacePath: adoptedTree,
	})
	if err != nil {
		t.Fatal(err)
	}
	if ws.created != 0 {
		t.Fatalf("workspace created %d times, want the provided tree adopted as-is", ws.created)
	}
	if s.Metadata.WorkspacePath != adoptedTree {
		t.Fatalf("metadata workspace path = %q, want %q", s.Metadata.WorkspacePath, adoptedTree)
	}
	if !s.Metadata.WorkspaceAdopted {
		t.Fatal("adopted spawn is not marked WorkspaceAdopted; teardown would treat the tree as its own")
	}
	if s.Metadata.Branch != "" {
		t.Fatalf("metadata branch = %q, want empty: the adopted tree already has one", s.Metadata.Branch)
	}
	if rt.lastCfg.WorkspacePath != adoptedTree {
		t.Fatalf("runtime workspace path = %q, want %q: the agent must run in the adopted tree", rt.lastCfg.WorkspacePath, adoptedTree)
	}
	if got := st.sessions["mer-1"].Metadata; got.WorkspacePath != adoptedTree || !got.WorkspaceAdopted {
		t.Fatalf("persisted metadata = %+v, want the adopted tree recorded", got)
	}
}

// The unset path is the ordinary one and must be untouched: the session gets
// its own worktree on its own generated branch, and owns it.
func TestSpawn_WithoutWorkspacePathCreatesItsOwnWorktree(t *testing.T) {
	m, _, rt, ws := newManager()
	s, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode, Prompt: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	if ws.created != 1 {
		t.Fatalf("workspace created %d times, want exactly one session worktree", ws.created)
	}
	if s.Metadata.WorkspacePath != "/ws/mer-1" {
		t.Fatalf("metadata workspace path = %q, want the created worktree", s.Metadata.WorkspacePath)
	}
	if s.Metadata.WorkspaceAdopted {
		t.Fatal("a session that created its own worktree is marked adopted")
	}
	if !strings.Contains(s.Metadata.Branch, "mer-1") {
		t.Fatalf("metadata branch = %q, want the generated session branch", s.Metadata.Branch)
	}
	if rt.lastCfg.WorkspacePath != "/ws/mer-1" {
		t.Fatalf("runtime workspace path = %q", rt.lastCfg.WorkspacePath)
	}
}

// A failed spawn rolls back what it built. An adopted tree is not one of those
// things: the pipeline run that provisioned it destroys it on its own terms.
func TestSpawn_FailureNeverDestroysAnAdoptedWorkspace(t *testing.T) {
	m, _, rt, ws := newManager()
	rt.createErr = errors.New("boom")
	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:     "mer",
		Kind:          domain.KindWorker,
		Harness:       domain.HarnessClaudeCode,
		Prompt:        "write a file",
		WorkspacePath: adoptedTree,
	})
	if err == nil {
		t.Fatal("spawn succeeded with a dead runtime")
	}
	if ws.destroyed != 0 {
		t.Fatalf("rollback destroyed %d workspaces, want the adopted tree left alone", ws.destroyed)
	}
}

// Kill terminates the session and tears down its runtime, but an adopted tree
// survives: session lifecycle does not own it.
func TestKill_NeverDestroysAnAdoptedWorkspace(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Metadata:  domain.SessionMetadata{WorkspacePath: adoptedTree, RuntimeHandleID: "h1", WorkspaceAdopted: true},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	freed, err := m.Kill(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if freed {
		t.Fatal("kill reported the workspace freed; it belongs to the run that provisioned it")
	}
	if ws.destroyed != 0 {
		t.Fatalf("kill destroyed %d workspaces, want 0", ws.destroyed)
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1: the pane is still the session's own", rt.destroyed)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session not terminated")
	}
}

// Cleanup reclaims the workspaces of terminal sessions. There is nothing to
// reclaim for an adopted tree, and reclaiming it would delete a run's workspace
// (or, for `workspace: session`, a live session's own tree).
func TestCleanup_LeavesAdoptedWorkspacesAlone(t *testing.T) {
	m, st, _, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: adoptedTree, WorkspaceAdopted: true})
	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if ws.destroyed != 0 {
		t.Fatalf("cleanup destroyed %d workspaces, want 0", ws.destroyed)
	}
	if len(res.Cleaned) != 0 {
		t.Fatalf("cleaned %v, want nothing reclaimed", res.Cleaned)
	}
	if len(res.Skipped) != 0 {
		t.Fatalf("skipped %v, want no refusal reported for a tree that was never ours", res.Skipped)
	}
}

// Shutdown captures uncommitted work and force-removes each session's worktree.
// An adopted tree is exempt from both: stashing into someone else's tree and
// then deleting it is exactly the race this flag exists to prevent.
func TestSaveAndTeardownAll_NeverDestroysAnAdoptedWorkspace(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Metadata: domain.SessionMetadata{
			WorkspacePath:    adoptedTree,
			Branch:           "ao/pipeline/run-a/run",
			RuntimeHandleID:  "h1",
			WorkspaceAdopted: true,
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}
	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatal(err)
	}
	if ws.stashCalls != 0 {
		t.Fatalf("stashed %d times in an adopted tree, want 0", ws.stashCalls)
	}
	for _, call := range ws.calls {
		if strings.HasPrefix(call, "ForceDestroy") {
			t.Fatalf("workspace calls = %v, want no ForceDestroy on an adopted tree", ws.calls)
		}
	}
	if rows := st.worktrees["mer-1"]; len(rows) != 0 {
		t.Fatalf("restore markers = %+v, want none: the tree is not ours to restore", rows)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session not terminated on shutdown")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1", rt.destroyed)
	}
}

// Restoring a session that runs in an adopted tree relaunches it where it
// already is. Re-creating the tree would either resurrect a run workspace or
// build a second worktree beside the one the record names.
func TestRestore_AdoptedWorkspaceIsNotRecreated(t *testing.T) {
	m, st, _, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{
		WorkspacePath:    adoptedTree,
		Branch:           "ao/pipeline/run-a/run",
		AgentSessionID:   "agent-x",
		WorkspaceAdopted: true,
	})
	out, err := m.RestoreWithMode(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if ws.created != 0 {
		t.Fatalf("restore created %d workspaces, want the adopted tree reused", ws.created)
	}
	if out.Session.Metadata.WorkspacePath != adoptedTree {
		t.Fatalf("restored workspace path = %q, want %q", out.Session.Metadata.WorkspacePath, adoptedTree)
	}
	if !out.Session.Metadata.WorkspaceAdopted {
		t.Fatal("restore dropped the adopted marker; the next teardown would delete the run's tree")
	}
}
