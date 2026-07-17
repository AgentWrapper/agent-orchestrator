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

func TestCleanupUninstallsWorkspaceHooks(t *testing.T) {
	agent := &hookCleanupAgent{}
	st := newFakeStore()
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-1" {
		t.Fatalf("cleaned = %#v, want mer-1", res.Cleaned)
	}
	if agent.uninstallCalls != 1 {
		t.Fatalf("UninstallHooks calls = %d, want 1", agent.uninstallCalls)
	}
	if agent.installCalls != 0 {
		t.Fatalf("GetAgentHooks calls = %d, want no install during cleanup", agent.installCalls)
	}
	if rt.destroyed != 1 || ws.destroyed != 1 {
		t.Fatalf("teardown counts runtime=%d workspace=%d, want 1/1", rt.destroyed, ws.destroyed)
	}
}

func TestCleanupDoesNotUninstallHooksFromInPlaceWorkspace(t *testing.T) {
	agent := &hookCleanupAgent{}
	st := newFakeStore()
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, RuntimeHandleID: "h1",
		},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-1" {
		t.Fatalf("cleaned = %#v, want mer-1", res.Cleaned)
	}
	if agent.uninstallCalls != 0 {
		t.Fatalf("UninstallHooks calls = %d, want none for in-place workspace", agent.uninstallCalls)
	}
	if rt.destroyed != 1 || ws.destroyed != 0 {
		t.Fatalf("teardown counts runtime=%d workspace=%d, want 1/0", rt.destroyed, ws.destroyed)
	}
}

func TestCleanupDoesNotUninstallHooksFromLiveSharedWorkspace(t *testing.T) {
	agent := &hookCleanupAgent{}
	st := newFakeStore()
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/shared", Branch: "ao/old", RuntimeHandleID: "old-runtime"},
	}
	st.sessions["mer-2"] = domain.SessionRecord{
		ID:        "mer-2",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/shared", Branch: "ao/new", RuntimeHandleID: "new-runtime"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	if len(res.Cleaned) != 0 || len(res.Skipped) != 1 || res.Skipped[0].SessionID != "mer-1" {
		t.Fatalf("cleaned = %#v skipped = %#v, want mer-1 skipped", res.Cleaned, res.Skipped)
	}
	if agent.uninstallCalls != 0 {
		t.Fatalf("UninstallHooks calls = %d, want none for live shared workspace", agent.uninstallCalls)
	}
	if rt.destroyed != 1 || ws.destroyed != 0 {
		t.Fatalf("teardown counts runtime=%d workspace=%d, want 1/0", rt.destroyed, ws.destroyed)
	}
}

func TestCleanupDoesNotUninstallGlobalHooks(t *testing.T) {
	agent := &globalHookCleanupAgent{}
	st := newFakeStore()
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessAutohand,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-1" {
		t.Fatalf("cleaned = %#v, want mer-1", res.Cleaned)
	}
	if agent.uninstallCalls != 0 {
		t.Fatalf("UninstallHooks calls = %d, want none for global hook config", agent.uninstallCalls)
	}
	if rt.destroyed != 1 || ws.destroyed != 1 {
		t.Fatalf("teardown counts runtime=%d workspace=%d, want 1/1", rt.destroyed, ws.destroyed)
	}
}
