package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// fakeCommander records what the adapter asked the session service to do.
type fakeCommander struct {
	spawned  ports.SpawnConfig
	spawnErr error
	killed   []domain.SessionID
	sent     map[domain.SessionID]string
}

func newFakeCommander() *fakeCommander {
	return &fakeCommander{sent: map[domain.SessionID]string{}}
}

func (c *fakeCommander) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error) {
	c.spawned = cfg
	if c.spawnErr != nil {
		return domain.Session{}, 0, 0, c.spawnErr
	}
	return domain.Session{SessionRecord: domain.SessionRecord{
		ID:       "sess-new",
		Metadata: domain.SessionMetadata{WorkspacePath: "/trees/sess-new"},
	}}, len(cfg.Prompt), 0, nil
}

func (c *fakeCommander) Kill(_ context.Context, id domain.SessionID) (bool, error) {
	c.killed = append(c.killed, id)
	return true, nil
}

func (c *fakeCommander) Send(_ context.Context, id domain.SessionID, message string) error {
	c.sent[id] = message
	return nil
}

// fakeSessionRows is the store half of the session seam.
type fakeSessionRows struct {
	rows map[domain.SessionID]domain.SessionRecord
	err  error
}

func (s fakeSessionRows) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	if s.err != nil {
		return domain.SessionRecord{}, false, s.err
	}
	rec, ok := s.rows[id]
	return rec, ok, nil
}

// fakeRuntime records the interrupts the adapter sent.
type fakeRuntime struct{ interrupted []string }

func (r *fakeRuntime) Interrupt(_ context.Context, handle ports.RuntimeHandle) error {
	r.interrupted = append(r.interrupted, handle.ID)
	return nil
}

func liveSession() domain.SessionRecord {
	return domain.SessionRecord{
		ID:       "sess-1",
		Activity: domain.Activity{State: domain.ActivityActive},
		Metadata: domain.SessionMetadata{WorkspacePath: "/trees/sess-1", RuntimeHandleID: "pane-1"},
	}
}

func TestSessionAdapterSpawnCarriesEnvAndPrompt(t *testing.T) {
	cmd := newFakeCommander()
	adapter := NewSessionAdapter(cmd, fakeSessionRows{}, nil, nil)

	out, err := adapter.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID:   "proj-1",
		Harness:     "claude-code",
		Prompt:      "do the thing",
		Env:         map[string]string{"AO_RUN_ID": "run-a", "AO_STAGE": "review"},
		DisplayName: "run-a/review",
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if out.SessionID != "sess-new" {
		t.Fatalf("session id = %q", out.SessionID)
	}
	if cmd.spawned.Env["AO_RUN_ID"] != "run-a" || cmd.spawned.Env["AO_STAGE"] != "review" {
		t.Fatalf("spawn env = %v, want the ambient identity `ao pipeline done` resolves itself from", cmd.spawned.Env)
	}
	if cmd.spawned.Prompt != "do the thing" || cmd.spawned.Kind != domain.KindWorker {
		t.Fatalf("spawn config = %+v", cmd.spawned)
	}
}

// The stage's session runs in the tree the driver already provisioned. Without
// this the session manager makes a worktree of its own and the agent works
// somewhere `workspace: run`, `inherit` and $AO_WORKSPACE do not name.
func TestSessionAdapterSpawnAdoptsTheResolvedWorkspace(t *testing.T) {
	cmd := newFakeCommander()
	adapter := NewSessionAdapter(cmd, fakeSessionRows{}, nil, nil)

	out, err := adapter.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID:     "proj-1",
		Prompt:        "write the file",
		WorkspacePath: "/runs/run-a/workspace",
		Env:           map[string]string{"AO_WORKSPACE": "/runs/run-a/workspace"},
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if cmd.spawned.WorkspacePath != "/runs/run-a/workspace" {
		t.Fatalf("spawn config workspace path = %q, want the resolved tree", cmd.spawned.WorkspacePath)
	}
	if out.WorkspacePath != "/trees/sess-new" {
		t.Fatalf("spawned workspace path = %q, want what the session manager reported", out.WorkspacePath)
	}
}

// Every pipeline-spawned session carries its run id into the spawn config, and
// the adapter reads that marker back as the session trigger bridge's loop guard.
func TestSessionAdapterMarksAndDetectsPipelineSpawnedSessions(t *testing.T) {
	cmd := newFakeCommander()
	adapter := NewSessionAdapter(cmd, fakeSessionRows{}, nil, nil)

	if _, err := adapter.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID: "proj-1",
		RunID:     "run-a",
		Prompt:    "review",
	}); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if cmd.spawned.PipelineRunID != "run-a" {
		t.Fatalf("spawn config pipeline run id = %q, want run-a: the loop guard has nothing to read without it", cmd.spawned.PipelineRunID)
	}

	rows := fakeSessionRows{rows: map[domain.SessionID]domain.SessionRecord{
		"sess-pipeline": {ID: "sess-pipeline", Metadata: domain.SessionMetadata{PipelineRunID: "run-a"}},
		"sess-human":    {ID: "sess-human"},
	}}
	guard := NewSessionAdapter(cmd, rows, nil, nil)

	spawned, err := guard.IsPipelineSpawned(context.Background(), "sess-pipeline")
	if err != nil || !spawned {
		t.Fatalf("IsPipelineSpawned(pipeline session) = %v, %v; want true", spawned, err)
	}
	spawned, err = guard.IsPipelineSpawned(context.Background(), "sess-human")
	if err != nil || spawned {
		t.Fatalf("IsPipelineSpawned(human session) = %v, %v; want false", spawned, err)
	}
	// An unknown session is not pipeline-spawned, and is not an error: the
	// bridge's own fail-safe covers reads it cannot answer.
	spawned, err = guard.IsPipelineSpawned(context.Background(), "sess-gone")
	if err != nil || spawned {
		t.Fatalf("IsPipelineSpawned(missing session) = %v, %v; want false, nil", spawned, err)
	}
	// A read failure propagates, so the bridge can take its fail-safe path
	// instead of treating an unreadable session as human-spawned.
	if _, err := NewSessionAdapter(cmd, fakeSessionRows{err: errors.New("db down")}, nil, nil).
		IsPipelineSpawned(context.Background(), "sess-pipeline"); err == nil {
		t.Fatal("loop guard swallowed a store failure, want the error surfaced")
	}
}

func TestSessionAdapterInterruptKeepsTheSession(t *testing.T) {
	cmd := newFakeCommander()
	runtime := &fakeRuntime{}
	rows := fakeSessionRows{rows: map[domain.SessionID]domain.SessionRecord{"sess-1": liveSession()}}
	adapter := NewSessionAdapter(cmd, rows, runtime, nil)

	if err := adapter.Interrupt(context.Background(), "sess-1"); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	if len(runtime.interrupted) != 1 || runtime.interrupted[0] != "pane-1" {
		t.Fatalf("interrupted %v, want the session's runtime pane", runtime.interrupted)
	}
	if len(cmd.killed) != 0 {
		t.Fatalf("killed %v, want the session and its scrollback kept", cmd.killed)
	}
}

func TestSessionAdapterInterruptWithoutAPaneIsNotAnError(t *testing.T) {
	rows := fakeSessionRows{rows: map[domain.SessionID]domain.SessionRecord{"sess-1": {ID: "sess-1"}}}
	adapter := NewSessionAdapter(newFakeCommander(), rows, &fakeRuntime{}, nil)
	if err := adapter.Interrupt(context.Background(), "sess-1"); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
}

func TestSessionAdapterKillIsIdempotent(t *testing.T) {
	cmd := newFakeCommander()
	adapter := NewSessionAdapter(cmd, fakeSessionRows{}, nil, nil)
	for range 2 {
		if err := adapter.Kill(context.Background(), "sess-gone"); err != nil {
			t.Fatalf("kill: %v", err)
		}
	}
	if len(cmd.killed) != 2 {
		t.Fatalf("killed %v", cmd.killed)
	}
}

func TestSessionAdapterAliveAndWorkspace(t *testing.T) {
	dead := liveSession()
	dead.ID = "sess-dead"
	dead.IsTerminated = true
	rows := fakeSessionRows{rows: map[domain.SessionID]domain.SessionRecord{
		"sess-1":    liveSession(),
		"sess-dead": dead,
	}}
	adapter := NewSessionAdapter(newFakeCommander(), rows, nil, nil)

	if alive, err := adapter.Alive(context.Background(), "sess-1"); err != nil || !alive {
		t.Fatalf("alive = %v, %v; want true", alive, err)
	}
	if alive, err := adapter.Alive(context.Background(), "sess-dead"); err != nil || alive {
		t.Fatalf("alive = %v, %v; want false for a terminated session", alive, err)
	}
	if alive, err := adapter.Alive(context.Background(), "sess-missing"); err != nil || alive {
		t.Fatalf("alive = %v, %v; want false for a missing session", alive, err)
	}

	path, ok, err := adapter.SessionWorkspaces().Get(context.Background(), "sess-1")
	if err != nil || !ok || path != "/trees/sess-1" {
		t.Fatalf("session workspace = %q, %v, %v", path, ok, err)
	}
}

// TestSessionAdapterGetReportsFirstSignal pins the fact the agent executor
// reads to tell a launching session from an idle one: a row whose
// FirstSignalAt is zero has never had a hook callback, so its seeded idle is
// not an observation.
func TestSessionAdapterGetReportsFirstSignal(t *testing.T) {
	launching := liveSession()
	launching.ID = "sess-launching"
	launching.Activity = domain.Activity{State: domain.ActivityIdle}
	reported := liveSession()
	reported.ID = "sess-reported"
	reported.Activity = domain.Activity{State: domain.ActivityIdle}
	reported.FirstSignalAt = time.Unix(1, 0)
	rows := fakeSessionRows{rows: map[domain.SessionID]domain.SessionRecord{
		"sess-launching": launching,
		"sess-reported":  reported,
	}}
	adapter := NewSessionAdapter(newFakeCommander(), rows, nil, nil)

	snap, ok, err := adapter.Get(context.Background(), "sess-launching")
	if err != nil || !ok {
		t.Fatalf("Get(sess-launching) = %v, %v", ok, err)
	}
	if snap.Signalled {
		t.Error("signalled = true for a session with no hook callback yet")
	}
	if snap, ok, err = adapter.Get(context.Background(), "sess-reported"); err != nil || !ok {
		t.Fatalf("Get(sess-reported) = %v, %v", ok, err)
	}
	if !snap.Signalled {
		t.Error("signalled = false for a session whose first hook callback landed")
	}
}

// fakeCredentialStore is the store half of the credential seam.
type fakeCredentialStore struct {
	creds map[string]map[string]string
	err   error
}

func (s fakeCredentialStore) GetPipelineCredential(_ context.Context, _ domain.ProjectID, name string) (map[string]string, bool, error) {
	if s.err != nil {
		return nil, false, s.err
	}
	env, ok := s.creds[name]
	return env, ok, nil
}

func (s fakeCredentialStore) ListPipelineCredentialNames(_ context.Context, _ domain.ProjectID) ([]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	names := make([]string, 0, len(s.creds))
	for name := range s.creds {
		names = append(names, name)
	}
	return names, nil
}

func TestCredentialAdapterResolvesInOrder(t *testing.T) {
	store := fakeCredentialStore{creds: map[string]map[string]string{
		"base":     {"TOKEN": "old", "OTHER": "keep"},
		"override": {"TOKEN": "new"},
	}}
	adapter := NewCredentialAdapter(store)

	env, err := adapter.Resolve(context.Background(), "proj-1", []string{"base", "override"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// A later name wins a key collision, and everything else survives.
	if env["TOKEN"] != "new" || env["OTHER"] != "keep" {
		t.Fatalf("env = %v", env)
	}
}

func TestCredentialAdapterUnknownNameIsAnError(t *testing.T) {
	adapter := NewCredentialAdapter(fakeCredentialStore{creds: map[string]map[string]string{}})
	if _, err := adapter.Resolve(context.Background(), "proj-1", []string{"missing"}); err == nil {
		t.Fatal("resolve succeeded, want an error: a stage that asked for a credential must never run without it")
	}
	ok, err := adapter.Exists(context.Background(), "proj-1", "missing")
	if err != nil || ok {
		t.Fatalf("exists = %v, %v; want false", ok, err)
	}
}

func TestCredentialAdapterReadFailurePropagates(t *testing.T) {
	adapter := NewCredentialAdapter(fakeCredentialStore{err: errors.New("db down")})
	if _, err := adapter.Names(context.Background(), "proj-1"); err == nil {
		t.Fatal("names succeeded, want the store error")
	}
}

// fakeProjects is the store half of the checkout seam.
type fakeProjects struct{ path string }

func (p fakeProjects) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	if p.path == "" {
		return domain.ProjectRecord{}, false, nil
	}
	return domain.ProjectRecord{ID: id, Path: p.path}, true, nil
}

func TestCheckoutAdapter(t *testing.T) {
	adapter := NewCheckoutAdapter(fakeProjects{path: "/repos/app"})
	path, err := adapter.CheckoutPath("proj-1")
	if err != nil || path != "/repos/app" {
		t.Fatalf("checkout = %q, %v", path, err)
	}

	if _, err := NewCheckoutAdapter(fakeProjects{}).CheckoutPath("proj-1"); err == nil {
		t.Fatal("unregistered project resolved a checkout")
	}
}
