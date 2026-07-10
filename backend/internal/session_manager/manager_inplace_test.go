package sessionmanager

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// inPlaceProjectConfig returns a project config whose top-level workspace mode
// is in-place, so both worker and orchestrator spawns resolve to in-place.
func inPlaceProjectConfig() domain.ProjectConfig {
	return domain.ProjectConfig{
		Workspace:    domain.WorkspaceModeInPlace,
		Worker:       domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}
}

// TestSpawn_InPlaceStartsAtRepoRootNoBranchNoProvision covers the spawn happy
// path for both roles under in-place mode: the session's cwd is the resolved
// project repo root, no daemon branch is created, the resolved mode is
// persisted, and per-project provisioning never runs.
func TestSpawn_InPlaceStartsAtRepoRootNoBranchNoProvision(t *testing.T) {
	for _, kind := range []domain.SessionKind{domain.KindWorker, domain.KindOrchestrator} {
		t.Run(string(kind), func(t *testing.T) {
			m, st, rt, ws := newManager()
			// A failing post-create command proves provisioning was skipped: if it
			// ran, the spawn would fail. The shared root is provisioned out of band.
			st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Config: func() domain.ProjectConfig {
				c := inPlaceProjectConfig()
				c.PostCreate = []string{"exit 3"}
				return c
			}()}
			ws.inPlacePath = "/repo/mer"

			s, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: kind})
			if err != nil {
				t.Fatalf("Spawn err = %v", err)
			}
			meta := st.sessions[s.ID].Metadata
			if meta.WorkspacePath != "/repo/mer" {
				t.Fatalf("WorkspacePath = %q, want the project repo root /repo/mer", meta.WorkspacePath)
			}
			if meta.Branch != "" {
				t.Fatalf("Branch = %q, want empty (in-place checks out no branch)", meta.Branch)
			}
			if meta.WorkspaceMode != domain.WorkspaceModeInPlace {
				t.Fatalf("persisted WorkspaceMode = %q, want in-place", meta.WorkspaceMode)
			}
			// The workspace adapter received the resolved mode and no branch.
			if ws.lastCfg.Mode != domain.WorkspaceModeInPlace {
				t.Fatalf("workspace cfg Mode = %q, want in-place", ws.lastCfg.Mode)
			}
			if ws.lastCfg.Branch != "" {
				t.Fatalf("workspace cfg Branch = %q, want empty", ws.lastCfg.Branch)
			}
			if rt.created != 1 {
				t.Fatalf("runtime.Create calls = %d, want 1 (spawn succeeded without provisioning)", rt.created)
			}
		})
	}
}

// TestSpawn_WorktreeModeUnchanged locks the default path: a project with no
// workspace mode configured still gets a computed session branch, runs
// provisioning, and persists the mode as worktree.
func TestSpawn_WorktreeModeUnchanged(t *testing.T) {
	m, st, _, ws := newManager()
	tmp := t.TempDir()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: tmp, Config: domain.ProjectConfig{
		Worker:     domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		PostCreate: []string{"echo hi > provisioned.txt"},
	}}
	ws.path = tmp // provisioning writes into the (worktree) workspace path

	s, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if err != nil {
		t.Fatalf("Spawn err = %v", err)
	}
	meta := st.sessions[s.ID].Metadata
	if meta.Branch != "ao/mer-1/root" {
		t.Fatalf("Branch = %q, want ao/mer-1/root (worktree mode computes a branch)", meta.Branch)
	}
	if meta.WorkspaceMode != domain.WorkspaceModeWorktree {
		t.Fatalf("persisted WorkspaceMode = %q, want worktree", meta.WorkspaceMode)
	}
	if ws.lastCfg.Mode != domain.WorkspaceModeWorktree {
		t.Fatalf("workspace cfg Mode = %q, want worktree", ws.lastCfg.Mode)
	}
	if _, err := os.Stat(filepath.Join(tmp, "provisioned.txt")); err != nil {
		t.Fatalf("post-create provisioning must run in worktree mode: %v", err)
	}
}

// TestSpawn_InPlaceRejectsExplicitBranch: an explicit --branch under in-place is
// a hard error, raised before any durable state is created (no seed row, no
// runtime).
func TestSpawn_InPlaceRejectsExplicitBranch(t *testing.T) {
	m, st, rt, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Config: inPlaceProjectConfig()}

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Branch: "feature/x"})
	if err == nil {
		t.Fatal("Spawn must reject an explicit branch under in-place mode")
	}
	if !errors.Is(err, ErrBranchNotAllowedInPlace) {
		t.Fatalf("err = %v, want ErrBranchNotAllowedInPlace", err)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("no session row may be left behind, got %d", len(st.sessions))
	}
	if rt.created != 0 {
		t.Fatalf("runtime.Create calls = %d, want 0", rt.created)
	}
	if ws.lastCfg.Mode != "" {
		t.Fatalf("workspace.Create must not be called; got cfg %+v", ws.lastCfg)
	}
}

// TestReconcileLive_InPlaceDeadTerminatedWithMarker: an in-place session with a
// dead runtime is marked terminated AND gets a session_worktrees marker row so
// RestoreAll relaunches it. Previously the branch-less guard returned early,
// leaving it looking live forever. No stash, no worktree removal.
func TestReconcileLive_InPlaceDeadTerminatedWithMarker(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveByHandle: map[string]bool{}} // handle not alive
	ws := &fakeWorkspace{stashRef: "should-not-be-used"}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", IsTerminated: false,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, RuntimeHandleID: "mer-1",
		},
	}

	if err := m.reconcileLive(ctx, rec); err != nil {
		t.Fatalf("reconcileLive err = %v", err)
	}
	if lcm.terminated["mer-1"] != 1 {
		t.Fatalf("MarkTerminated = %d, want 1 (dead in-place session must not be left live)", lcm.terminated["mer-1"])
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 1 {
		t.Fatalf("session_worktrees marker rows = %d, want 1 (the relaunch-me signal)", len(rows))
	}
	if rows[0].Branch != "" || rows[0].PreservedRef != "" {
		t.Fatalf("in-place marker = %+v, want empty branch and empty preserve ref", rows[0])
	}
	if ws.stashCalls != 0 {
		t.Fatalf("StashUncommitted calls = %d, want 0 (nothing session-scoped in the shared root)", ws.stashCalls)
	}
	for _, c := range ws.calls {
		if c == "ForceDestroy:mer-1" {
			t.Fatalf("the shared repo root must never be force-destroyed; calls = %v", ws.calls)
		}
	}
}

// TestReconcileLive_InPlaceAliveAdopted: an in-place session whose runtime
// survived the crash is adopted unchanged — no terminate, no marker, no stash.
func TestReconcileLive_InPlaceAliveAdopted(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"mer-1": true}}
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", IsTerminated: false,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, RuntimeHandleID: "mer-1",
		},
	}

	if err := m.reconcileLive(ctx, rec); err != nil {
		t.Fatalf("reconcileLive err = %v", err)
	}
	if lcm.terminated["mer-1"] != 0 || len(st.worktrees["mer-1"]) != 0 || ws.stashCalls != 0 {
		t.Fatalf("alive in-place session must be a no-op: term=%d rows=%d stash=%d",
			lcm.terminated["mer-1"], len(st.worktrees["mer-1"]), ws.stashCalls)
	}
}

// TestSaveAndTeardownAll_InPlaceNotSkipped: SaveAndTeardownAll no longer skips a
// branch-less in-place session — it writes the marker row, marks terminated, and
// tears down the runtime, without touching the shared root.
func TestSaveAndTeardownAll_InPlaceNotSkipped(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker,
		Metadata: domain.SessionMetadata{WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, RuntimeHandleID: "h1"},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 1 || rows[0].Branch != "" || rows[0].PreservedRef != "" {
		t.Fatalf("in-place session must get an empty-ref marker row, got %+v", rows)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("in-place session must be marked terminated by SaveAndTeardownAll")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed = %d, want 1", rt.destroyed)
	}
	for _, c := range ws.calls {
		if c == "ForceDestroy:mer-1" {
			t.Fatalf("the shared repo root must never be force-destroyed; calls = %v", ws.calls)
		}
	}
}

// TestRestoreAll_InPlaceRelaunchesAtRepoRoot: a saved in-place session is
// relaunched at the project repo root, with the in-place mode carried through to
// the workspace adapter.
func TestRestoreAll_InPlaceRelaunchesAtRepoRoot(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	ws.inPlacePath = "/repo/mer"
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, AgentSessionID: "agent-w",
		},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	// The shutdown-saved marker (empty ref, empty branch) is the relaunch signal.
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName}}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create = %d, want 1 (in-place session relaunched)", rt.created)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("in-place session must be live after RestoreAll")
	}
	if ws.lastCfg.Mode != domain.WorkspaceModeInPlace {
		t.Fatalf("workspace restore Mode = %q, want in-place", ws.lastCfg.Mode)
	}
	if got := st.sessions["mer-1"].Metadata.WorkspacePath; got != "/repo/mer" {
		t.Fatalf("restored WorkspacePath = %q, want /repo/mer", got)
	}
}

// TestRestoreAll_EmptyModeKeepsWorktreeNoRugPull: a pre-upgrade session record
// with an empty persisted WorkspaceMode and a real branch restores into its
// worktree exactly as before — the zero value must never be read as in-place.
func TestRestoreAll_EmptyModeKeepsWorktreeNoRugPull(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata: domain.SessionMetadata{
			// No WorkspaceMode set: the pre-upgrade shape.
			WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w",
		},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName}}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create = %d, want 1", rt.created)
	}
	// The empty mode must normalize to worktree, preserving the branch and the
	// per-session worktree path — not the repo root.
	if ws.lastCfg.Mode != domain.WorkspaceModeWorktree {
		t.Fatalf("workspace restore Mode = %q, want worktree (empty normalizes to worktree)", ws.lastCfg.Mode)
	}
	if ws.lastCfg.Branch != "ao/mer-1/root" {
		t.Fatalf("restore Branch = %q, want ao/mer-1/root", ws.lastCfg.Branch)
	}
	if got := st.sessions["mer-1"].Metadata.WorkspacePath; got != "/ws/mer-1" {
		t.Fatalf("restored WorkspacePath = %q, want the worktree path /ws/mer-1", got)
	}
}

// TestSwitchHarness_InPlaceLiveSwapAllowed: a live in-place session (no branch)
// can have its harness swapped. Before the mode-aware guard, the branch-less
// metadata was wrongly rejected as an incomplete handle.
func TestSwitchHarness_InPlaceLiveSwapAllowed(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: inPlaceProjectConfig()}
	rt := &fakeRuntime{}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})
	id := domain.SessionID("mer-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{
			// In-place: WorkspacePath set, Branch empty, mode persisted.
			WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace,
			RuntimeHandleID: "h1", AgentSessionID: "old-native", Prompt: "do it",
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	rec, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "")
	if err != nil {
		t.Fatalf("SwitchHarness on in-place session err = %v (branch-less in-place must be switchable)", err)
	}
	if rec.Harness != domain.HarnessCodex {
		t.Fatalf("harness = %q, want codex", rec.Harness)
	}
	if rt.destroyed != 1 || rt.created != 1 {
		t.Fatalf("runtime destroyed=%d created=%d, want 1/1", rt.destroyed, rt.created)
	}
}

// TestSwitchHarness_InPlaceTerminatedRelaunchPassesMode: relaunching a
// terminated in-place session under a new harness must forward the in-place mode
// to the workspace adapter (so it resolves the repo root, not a worktree).
func TestSwitchHarness_InPlaceTerminatedRelaunchPassesMode(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: inPlaceProjectConfig()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{inPlacePath: "/repo/mer"}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})
	id := domain.SessionID("mer-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace,
			RuntimeHandleID: "h1", AgentSessionID: "old-native", Prompt: "do it",
		},
		Activity: domain.Activity{State: domain.ActivityExited},
	}

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, ""); err != nil {
		t.Fatalf("SwitchHarness relaunch err = %v", err)
	}
	if ws.lastCfg.Mode != domain.WorkspaceModeInPlace {
		t.Fatalf("workspace restore Mode = %q, want in-place", ws.lastCfg.Mode)
	}
	if ws.lastCfg.Branch != "" {
		t.Fatalf("workspace restore Branch = %q, want empty", ws.lastCfg.Branch)
	}
}

// TestCleanup_InPlaceNeverDestroyedNorSkipped: a terminated in-place session is
// counted as cleaned (its runtime reclaimed) and never has its workspace
// destroyed — even while a live in-place session shares the exact same path.
func TestCleanup_InPlaceNeverDestroyedNorSkipped(t *testing.T) {
	m, st, rt, ws := newManager()
	// Terminated in-place predecessor and a live in-place session share the one
	// repo root — the case that would otherwise mark the predecessor permanently
	// Skipped by the liveWorkspacePaths guard.
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", IsTerminated: true,
		Metadata: domain.SessionMetadata{WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, RuntimeHandleID: "mer-1-runtime"},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	st.sessions["mer-2"] = domain.SessionRecord{
		ID: "mer-2", ProjectID: "mer", IsTerminated: false,
		Metadata: domain.SessionMetadata{WorkspacePath: "/repo/mer", WorkspaceMode: domain.WorkspaceModeInPlace, RuntimeHandleID: "mer-2-runtime"},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatalf("Cleanup err = %v", err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-1" {
		t.Fatalf("cleaned = %v, want [mer-1]", res.Cleaned)
	}
	if len(res.Skipped) != 0 {
		t.Fatalf("skipped = %v, want none (in-place is never skipped for a shared path)", res.Skipped)
	}
	if ws.destroyed != 0 {
		t.Fatalf("workspace.Destroy calls = %d, want 0 (the shared repo root is never destroyed)", ws.destroyed)
	}
	// The terminated session's own runtime handle is still reclaimed.
	if rt.destroyed != 1 || len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "mer-1-runtime" {
		t.Fatalf("runtime destroyed = %d ids=%v, want the terminated session's handle torn down", rt.destroyed, rt.destroyedIDs)
	}
}

// TestKill_InPlaceReportsNothingFreed: Destroy is a deliberate no-op for an
// in-place workspace, so Kill must not report that one was reclaimed. The flag
// is surfaced verbatim as KillSessionResponse.Freed, and telling an operator the
// shared repo root was freed is a lie about their own working tree.
func TestKill_InPlaceReportsNothingFreed(t *testing.T) {
	m, st, rt, ws := newManager()
	rec := mkLive("mer-1")
	rec.Metadata.WorkspacePath = "/repo"
	rec.Metadata.WorkspaceMode = domain.WorkspaceModeInPlace
	st.sessions["mer-1"] = rec

	freed, err := m.Kill(ctx, "mer-1")
	if err != nil {
		t.Fatalf("kill: %v", err)
	}
	if freed {
		t.Fatal("Kill reported freed=true for an in-place session; the repo root is never reclaimed")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed = %d, want 1 — the pane is still torn down", rt.destroyed)
	}
	if ws.destroyed != 0 {
		t.Fatalf("workspace destroyed = %d, want 0 for in-place", ws.destroyed)
	}
}

// TestKill_WorktreeStillReportsFreed pins the other side: worktree mode is
// unchanged and still reports the reclaim.
func TestKill_WorktreeStillReportsFreed(t *testing.T) {
	m, st, _, _ := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")

	freed, err := m.Kill(ctx, "mer-1")
	if err != nil || !freed {
		t.Fatalf("worktree kill: freed=%v err=%v, want freed=true", freed, err)
	}
}
