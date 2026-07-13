package sessionmanager

import (
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestCleanupSkipsSessionWhoseRuntimeTeardownFails pins #293 M5: cleanup
// discarded runtime.Destroy errors, destroyed the workspace anyway, and still
// reported the session as Cleaned — success after teardown failed. A runtime
// that will not die must leave the workspace in place and be reported as
// skipped, so the teardown stays truthfully retryable.
func TestCleanupSkipsSessionWhoseRuntimeTeardownFails(t *testing.T) {
	m, st, rt, ws := newManager()
	rt.destroyErr = errors.New("tmux: server not responding")
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	if len(res.Cleaned) != 0 {
		t.Fatalf("reported %v as cleaned although runtime teardown failed", res.Cleaned)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].SessionID != "mer-1" {
		t.Fatalf("skipped = %#v, want the session whose runtime teardown failed", res.Skipped)
	}
	if ws.destroyed != 0 {
		t.Fatalf("workspace destroyed %d times although the runtime is still up", ws.destroyed)
	}
}
