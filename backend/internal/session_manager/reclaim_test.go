package sessionmanager

import (
	"fmt"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ReclaimOnTerminate is the teardown lifecycle runs after a merge/close/tracker
// termination (#2811). It must destroy the runtime and worktree of a terminated
// session — the reclaim that MarkTerminated deliberately skips.
func TestReclaimOnTerminate_ReclaimsTerminatedWorktree(t *testing.T) {
	m, st, rt, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", RuntimeHandleID: "h1"})

	if err := m.ReclaimOnTerminate(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if ws.destroyed != 1 {
		t.Fatalf("worktree should be reclaimed, destroyed=%d", ws.destroyed)
	}
	if rt.destroyed != 1 || len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "h1" {
		t.Fatalf("runtime handle should be destroyed, got %d %v", rt.destroyed, rt.destroyedIDs)
	}
}

// A dirty worktree is preserved, never force-removed (the data-safety hard
// rule). The reclaim is best-effort, so it swallows the refusal rather than
// surfacing an error to the observation pipeline.
func TestReclaimOnTerminate_PreservesDirtyWorktree(t *testing.T) {
	m, st, _, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1"})
	ws.destroyErr = fmt.Errorf("gitworktree: refusing to remove: %w", ports.ErrWorkspaceDirty)

	if err := m.ReclaimOnTerminate(ctx, "mer-1"); err != nil {
		t.Fatalf("dirty worktree refusal must be swallowed, got %v", err)
	}
}

// A session that is not (yet) terminated must never be reclaimed: reclaiming a
// live worktree would pull it out from under a working agent. This is the guard
// against a caller-ordering slip.
func TestReclaimOnTerminate_NoopWhenNotTerminated(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")

	if err := m.ReclaimOnTerminate(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if ws.destroyed != 0 || rt.destroyed != 0 {
		t.Fatalf("live session must not be torn down, ws=%d rt=%d", ws.destroyed, rt.destroyed)
	}
}

// An unknown session id is a benign no-op (e.g. a session deleted between the
// terminate write and the reclaim call).
func TestReclaimOnTerminate_NoopWhenUnknown(t *testing.T) {
	m, _, rt, ws := newManager()

	if err := m.ReclaimOnTerminate(ctx, "ghost"); err != nil {
		t.Fatal(err)
	}
	if ws.destroyed != 0 || rt.destroyed != 0 {
		t.Fatalf("unknown session must be a no-op, ws=%d rt=%d", ws.destroyed, rt.destroyed)
	}
}
