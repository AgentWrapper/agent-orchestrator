package sessionmanager

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The fakes in manager_test.go are single-goroutine helpers (unguarded maps).
// The kill-vs-switch/restore races need concurrent callers, so this file carries
// its own mutex-guarded store/runtime/workspace and drives the REAL
// lifecycle.Manager — the component whose MarkSwitched/MarkSpawned writes
// unconditionally clear IsTerminated and thus could resurrect a killed session
// (#293 H1).

// raceStore is a concurrency-safe session store that satisfies both the session
// manager's Store and the lifecycle reducer's session store.
type raceStore struct {
	mu        sync.Mutex
	sessions  map[domain.SessionID]domain.SessionRecord
	projects  map[string]domain.ProjectRecord
	worktrees map[domain.SessionID][]domain.SessionWorktreeRecord
	// getHook, when set, runs at the start of GetSession (outside the store
	// lock) so a test can park a command that holds the session's command slot
	// even when that command performs no other blocking I/O.
	getHook func(domain.SessionID)
}

func newRaceStore() *raceStore {
	return &raceStore{
		sessions:  map[domain.SessionID]domain.SessionRecord{},
		projects:  map[string]domain.ProjectRecord{},
		worktrees: map[domain.SessionID][]domain.SessionWorktreeRecord{},
	}
}

func (s *raceStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.projects[id]
	return rec, ok, nil
}

func (s *raceStore) ListWorkspaceRepos(context.Context, string) ([]domain.WorkspaceRepoRecord, error) {
	return nil, nil
}

func (s *raceStore) CreateSession(_ context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[rec.ID] = rec
	return rec, nil
}

func (s *raceStore) UpdateSession(_ context.Context, rec domain.SessionRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[rec.ID] = rec
	return nil
}

func (s *raceStore) ClearSessionPendingDecision(context.Context, domain.SessionID, time.Time) (bool, error) {
	return false, nil
}

func (s *raceStore) RenameSession(context.Context, domain.SessionID, string, time.Time) (bool, error) {
	return false, nil
}

func (s *raceStore) SetSessionIssue(context.Context, domain.SessionID, domain.IssueID, string, time.Time) (bool, error) {
	return false, nil
}

func (s *raceStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	s.mu.Lock()
	hook := s.getHook
	s.mu.Unlock()
	if hook != nil {
		hook(id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.sessions[id]
	return rec, ok, nil
}

func (s *raceStore) ListSessions(_ context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.SessionRecord
	for _, rec := range s.sessions {
		if rec.ProjectID == project {
			out = append(out, rec)
		}
	}
	return out, nil
}

func (s *raceStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.SessionRecord
	for _, rec := range s.sessions {
		out = append(out, rec)
	}
	return out, nil
}

func (s *raceStore) DeleteSession(context.Context, domain.SessionID) (bool, error) {
	return false, nil
}

func (s *raceStore) UpsertSessionWorktree(_ context.Context, row domain.SessionWorktreeRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.worktrees[row.SessionID] = append(s.worktrees[row.SessionID], row)
	return nil
}

func (s *raceStore) ListSessionWorktrees(_ context.Context, id domain.SessionID) ([]domain.SessionWorktreeRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.worktrees[id], nil
}

func (s *raceStore) DeleteSessionWorktrees(_ context.Context, id domain.SessionID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.worktrees, id)
	return nil
}

// ---- lifecycle.sessionStore surface (unused by these paths, but required) ----

func (s *raceStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	return nil, nil
}

func (s *raceStore) GetPRLastNudgeSignature(context.Context, string) (string, error) {
	return "", nil
}

func (s *raceStore) UpdatePRLastNudgeSignature(context.Context, string, string) error { return nil }

func (s *raceStore) session(t *testing.T, id domain.SessionID) domain.SessionRecord {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.sessions[id]
	if !ok {
		t.Fatalf("session %s missing from store", id)
	}
	return rec
}

// raceRuntime is a concurrency-safe runtime that tracks which handles are live,
// so a test can assert no runtime outlived a kill. createGate, when set, parks
// Create (after announcing itself on createStarted) until the test releases it.
type raceRuntime struct {
	mu           sync.Mutex
	num          int
	live         map[string]bool
	createGate   chan struct{}
	createStared chan string
}

func newRaceRuntime() *raceRuntime {
	return &raceRuntime{live: map[string]bool{}}
}

func (r *raceRuntime) Create(_ context.Context, _ ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	r.mu.Lock()
	gate := r.createGate
	started := r.createStared
	r.num++
	id := "rt-" + string(rune('a'+r.num-1))
	r.mu.Unlock()

	if started != nil {
		started <- id
	}
	if gate != nil {
		<-gate
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.live[id] = true
	return ports.RuntimeHandle{ID: id}, nil
}

func (r *raceRuntime) Destroy(_ context.Context, handle ports.RuntimeHandle) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.live, handle.ID)
	return nil
}

func (r *raceRuntime) IsAlive(_ context.Context, handle ports.RuntimeHandle) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live[handle.ID], nil
}

func (r *raceRuntime) IsRunningCommand(context.Context, ports.RuntimeHandle, string) (bool, error) {
	return true, nil
}

func (r *raceRuntime) SendMessage(context.Context, ports.RuntimeHandle, string) error { return nil }

func (r *raceRuntime) GetOutput(context.Context, ports.RuntimeHandle, int) (string, error) {
	return "", nil
}

func (r *raceRuntime) liveHandles() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.live))
	for id := range r.live {
		out = append(out, id)
	}
	return out
}

func (r *raceRuntime) created() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.num
}

// raceWorkspace is a concurrency-safe workspace whose Destroy can be parked so a
// test can hold a Kill mid-teardown.
type raceWorkspace struct {
	mu          sync.Mutex
	destroyGate chan struct{}
	destroyed   chan struct{}
	// destroyErr, when set, is returned by Destroy after the gate releases —
	// ports.ErrWorkspaceDirty stands in for a worktree the safety check refuses
	// to remove because it holds uncommitted work.
	destroyErr error
}

func (w *raceWorkspace) Create(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	return ports.WorkspaceInfo{Path: "/ws/" + string(cfg.SessionID), Branch: cfg.Branch, Mode: cfg.Mode}, nil
}

func (w *raceWorkspace) Destroy(_ context.Context, _ ports.WorkspaceInfo) error {
	w.mu.Lock()
	gate := w.destroyGate
	announce := w.destroyed
	w.mu.Unlock()
	if announce != nil {
		close(announce)
		w.mu.Lock()
		w.destroyed = nil
		w.mu.Unlock()
	}
	if gate != nil {
		<-gate
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.destroyErr
}

func (w *raceWorkspace) Restore(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	path := cfg.RestorePath
	if path == "" {
		path = "/ws/" + string(cfg.SessionID)
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, Mode: cfg.Mode}, nil
}

func (w *raceWorkspace) ForceDestroy(context.Context, ports.WorkspaceInfo) error { return nil }

func (w *raceWorkspace) StashUncommitted(context.Context, ports.WorkspaceInfo) (string, error) {
	return "", nil
}

func (w *raceWorkspace) ApplyPreserved(context.Context, ports.WorkspaceInfo, string) error {
	return nil
}

type raceMessenger struct{}

func (raceMessenger) Send(context.Context, domain.SessionID, string) error { return nil }

// newRaceManager builds a manager over concurrency-safe fakes and the real
// lifecycle reducer, seeded with one live session.
func newRaceManager(t *testing.T) (*Manager, *raceStore, *raceRuntime, *raceWorkspace, domain.SessionID) {
	t.Helper()
	st := newRaceStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := newRaceRuntime()
	ws := &raceWorkspace{}
	lcm := lifecycle.New(st, raceMessenger{})

	id := domain.SessionID("mer-1")
	rt.mu.Lock()
	rt.num = 1
	rt.live["rt-a"] = true
	rt.mu.Unlock()
	st.sessions[id] = domain.SessionRecord{
		ID:        id,
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.AgentHarness("claude-code"),
		Metadata: domain.SessionMetadata{
			WorkspacePath:   "/ws/mer-1",
			Branch:          "ao/mer-1",
			RuntimeHandleID: "rt-a",
			Prompt:          "do the thing",
		},
	}

	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: raceMessenger{},
		Lifecycle: lcm,
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
	})
	return m, st, rt, ws, id
}

// pauseWindow bounds how long a test waits for a command that the FIXED code
// serializes (and therefore parks). It never gates an assertion: every
// assertion below is evaluated after both commands have returned, so a shorter
// or longer window cannot change the verdict — it only bounds the window in
// which the unfixed code is free to interleave.
const pauseWindow = 250 * time.Millisecond

// TestKillDuringSwitchDoesNotResurrectSession pins #293 H1: a switch that is
// already past its preflight when a kill lands must not resurrect the killed
// session, and no runtime it created may outlive the kill.
func TestKillDuringSwitchDoesNotResurrectSession(t *testing.T) {
	m, st, rt, _, id := newRaceManager(t)

	release := make(chan struct{})
	started := make(chan string, 1)
	rt.mu.Lock()
	rt.createGate = release
	rt.createStared = started
	rt.mu.Unlock()

	var switchErr error
	switchDone := make(chan struct{})
	go func() {
		defer close(switchDone)
		_, switchErr = m.SwitchHarness(context.Background(), id, domain.AgentHarness("codex"), "")
	}()

	// The switch is now past preflight and inside runtime creation — the exact
	// window the issue describes.
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("switch never reached runtime creation")
	}

	killDone := make(chan struct{})
	go func() {
		defer close(killDone)
		if _, err := m.Kill(context.Background(), id); err != nil {
			t.Errorf("kill: %v", err)
		}
	}()

	// Unfixed, Kill runs straight through here (nothing serializes it) and the
	// switch then revives the row. Fixed, Kill parks on the session's command
	// slot until the switch finishes.
	select {
	case <-killDone:
	case <-time.After(pauseWindow):
	}
	close(release)

	<-switchDone
	<-killDone

	rec := st.session(t, id)
	if !rec.IsTerminated {
		t.Fatalf("killed session was resurrected: IsTerminated=false (switch err=%v)", switchErr)
	}
	if live := rt.liveHandles(); len(live) != 0 {
		t.Fatalf("runtime outlived the kill: %v (switch err=%v)", live, switchErr)
	}
}

// TestSwitchQueuedBehindKillDoesNotRelaunch pins the other H1 interleaving: a
// switch admitted BEFORE the kill completes must lose to the kill rather than
// launch a fresh runtime for a session the operator has already killed.
func TestSwitchQueuedBehindKillDoesNotRelaunch(t *testing.T) {
	m, st, rt, ws, id := newRaceManager(t)

	releaseKill := make(chan struct{})
	killTearingDown := make(chan struct{})
	ws.mu.Lock()
	ws.destroyGate = releaseKill
	ws.destroyed = killTearingDown
	ws.mu.Unlock()

	killDone := make(chan struct{})
	go func() {
		defer close(killDone)
		if _, err := m.Kill(context.Background(), id); err != nil {
			t.Errorf("kill: %v", err)
		}
	}()

	select {
	case <-killTearingDown:
	case <-time.After(5 * time.Second):
		t.Fatal("kill never reached workspace teardown")
	}

	var switchErr error
	switchDone := make(chan struct{})
	go func() {
		defer close(switchDone)
		_, switchErr = m.SwitchHarness(context.Background(), id, domain.AgentHarness("codex"), "")
	}()

	// Unfixed, the switch runs concurrently with the parked kill and launches a
	// new runtime the kill never sees. Fixed, it parks behind the kill.
	select {
	case <-switchDone:
	case <-time.After(pauseWindow):
	}
	close(releaseKill)

	<-killDone
	<-switchDone

	if !errors.Is(switchErr, ErrTerminated) {
		t.Fatalf("switch err = %v, want ErrTerminated (kill wins)", switchErr)
	}
	rec := st.session(t, id)
	if !rec.IsTerminated {
		t.Fatal("killed session was resurrected: IsTerminated=false")
	}
	if live := rt.liveHandles(); len(live) != 0 {
		t.Fatalf("runtime outlived the kill: %v", live)
	}
	if created := rt.created(); created != 1 {
		t.Fatalf("runtime created after terminal intent: %d creates, want 1 (the seeded one)", created)
	}
}

// TestRestoreQueuedBehindKillDoesNotRelaunch pins the restore half of H1: the
// read-kill-create race in Restore must not bring a killed session back.
func TestRestoreQueuedBehindKillDoesNotRelaunch(t *testing.T) {
	m, st, rt, ws, id := newRaceManager(t)

	releaseKill := make(chan struct{})
	killTearingDown := make(chan struct{})
	ws.mu.Lock()
	ws.destroyGate = releaseKill
	ws.destroyed = killTearingDown
	ws.mu.Unlock()

	// Restore only accepts a terminated session; terminate the row first so the
	// race under test is kill-vs-restore rather than restore's own guard.
	rec := st.session(t, id)
	rec.IsTerminated = true
	if err := st.UpdateSession(context.Background(), rec); err != nil {
		t.Fatalf("seed terminated: %v", err)
	}

	killDone := make(chan struct{})
	go func() {
		defer close(killDone)
		if _, err := m.Kill(context.Background(), id); err != nil {
			t.Errorf("kill: %v", err)
		}
	}()

	select {
	case <-killTearingDown:
	case <-time.After(5 * time.Second):
		t.Fatal("kill never reached workspace teardown")
	}

	var restoreErr error
	restoreDone := make(chan struct{})
	go func() {
		defer close(restoreDone)
		_, restoreErr = m.Restore(context.Background(), id)
	}()

	select {
	case <-restoreDone:
	case <-time.After(pauseWindow):
	}
	close(releaseKill)

	<-killDone
	<-restoreDone

	if !errors.Is(restoreErr, ErrTerminated) {
		t.Fatalf("restore err = %v, want ErrTerminated (kill wins)", restoreErr)
	}
	if got := st.session(t, id); !got.IsTerminated {
		t.Fatal("killed session was resurrected by restore: IsTerminated=false")
	}
	if live := rt.liveHandles(); len(live) != 0 {
		t.Fatalf("runtime outlived the kill: %v", live)
	}
}

// TestSwitchQueuedBehindDirtyKillDoesNotRelaunch pins the issue's own #293 H1
// reproduction, the one the first fix missed: "pause a switch after preflight
// but before runtime creation; kill a DIRTY-worktree session; release the
// switch."
//
// A kill whose workspace removal is refused (uncommitted work) returns early —
// before MarkTerminated — leaving the DB row live. The command slot alone does
// not save the session there: the switch queued behind that kill sees a live
// row and, unless the kill recorded its terminal INTENT (not merely its
// successful teardown), builds a replacement runtime and MarkSwitched's back to
// life the agent the operator just killed.
func TestSwitchQueuedBehindDirtyKillDoesNotRelaunch(t *testing.T) {
	m, st, rt, ws, id := newRaceManager(t)

	releaseKill := make(chan struct{})
	killTearingDown := make(chan struct{})
	ws.mu.Lock()
	ws.destroyGate = releaseKill
	ws.destroyed = killTearingDown
	// The worktree holds uncommitted work: removal is refused and Kill returns
	// (freed=false, nil) — a SUCCESSFUL kill that preserved the workspace.
	ws.destroyErr = ports.ErrWorkspaceDirty
	ws.mu.Unlock()

	killDone := make(chan struct{})
	go func() {
		defer close(killDone)
		freed, err := m.Kill(context.Background(), id)
		if err != nil {
			t.Errorf("kill: %v", err)
		}
		if freed {
			t.Errorf("kill freed a dirty workspace: freed=true, want false")
		}
	}()

	select {
	case <-killTearingDown:
	case <-time.After(5 * time.Second):
		t.Fatal("kill never reached workspace teardown")
	}

	var switchErr error
	switchDone := make(chan struct{})
	go func() {
		defer close(switchDone)
		_, switchErr = m.SwitchHarness(context.Background(), id, domain.AgentHarness("codex"), "")
	}()

	select {
	case <-switchDone:
	case <-time.After(pauseWindow):
	}
	close(releaseKill)

	<-killDone
	<-switchDone

	if !errors.Is(switchErr, ErrTerminated) {
		t.Fatalf("switch err = %v, want ErrTerminated (kill wins even when the dirty workspace is preserved)", switchErr)
	}
	if live := rt.liveHandles(); len(live) != 0 {
		t.Fatalf("runtime outlived the kill: %v", live)
	}
	if created := rt.created(); created != 1 {
		t.Fatalf("runtime created after terminal intent: %d creates, want 1 (the seeded one)", created)
	}
	// The kill preserved the dirty workspace and deliberately leaves the row
	// un-terminated as retryable inventory, so the row itself is not the
	// assertion — but the switch must not have written its completion over it.
	if got := st.session(t, id).Harness; got != domain.AgentHarness("claude-code") {
		t.Fatalf("switch completed over a killed session: harness = %q, want claude-code", got)
	}
}

// TestRestoreQueuedBehindRetireDoesNotRelaunch pins the other intent-loss path:
// RetireForReplacement early-returns nil for a record that is already
// terminated. A restore admitted while retirement holds the slot must still lose
// to it — otherwise the retired predecessor is relaunched onto the canonical
// branch the replacement session is claiming.
func TestRestoreQueuedBehindRetireDoesNotRelaunch(t *testing.T) {
	m, st, rt, _, id := newRaceManager(t)

	// The record is already terminated, so RetireForReplacement takes its
	// already-terminated early return.
	rec := st.session(t, id)
	rec.IsTerminated = true
	if err := st.UpdateSession(context.Background(), rec); err != nil {
		t.Fatalf("seed terminated: %v", err)
	}

	retireReading := make(chan struct{})
	releaseRetire := make(chan struct{})
	var once sync.Once
	st.mu.Lock()
	st.getHook = func(domain.SessionID) {
		// Park only the first read — retirement's — holding the command slot.
		once.Do(func() {
			close(retireReading)
			<-releaseRetire
		})
	}
	st.mu.Unlock()

	retireDone := make(chan struct{})
	go func() {
		defer close(retireDone)
		if err := m.RetireForReplacement(context.Background(), id); err != nil {
			t.Errorf("retire: %v", err)
		}
	}()

	select {
	case <-retireReading:
	case <-time.After(5 * time.Second):
		t.Fatal("retire never read the session row")
	}

	var restoreErr error
	restoreDone := make(chan struct{})
	go func() {
		defer close(restoreDone)
		_, restoreErr = m.Restore(context.Background(), id)
	}()

	select {
	case <-restoreDone:
	case <-time.After(pauseWindow):
	}
	close(releaseRetire)

	<-retireDone
	<-restoreDone

	if !errors.Is(restoreErr, ErrTerminated) {
		t.Fatalf("restore err = %v, want ErrTerminated (retirement wins)", restoreErr)
	}
	if !st.session(t, id).IsTerminated {
		t.Fatal("retired session was resurrected by restore: IsTerminated=false")
	}
	if created := rt.created(); created != 1 {
		t.Fatalf("runtime created for a retired session: %d creates, want 1 (the seeded one)", created)
	}
}
