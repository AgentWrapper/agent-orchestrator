package drain

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

type fakeStore struct {
	projects    []domain.ProjectRecord
	fleetPaused bool
}

func (f *fakeStore) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	return append([]domain.ProjectRecord(nil), f.projects...), nil
}
func (f *fakeStore) GetFleetPaused(context.Context) (bool, error) { return f.fleetPaused, nil }

type fakeSessions struct {
	byProject map[domain.ProjectID][]domain.Session
	killed    []domain.SessionID
	// killNoop lists sessions whose Kill returns (false, nil) — e.g. a dirty
	// worktree the manager preserves.
	killNoop map[domain.SessionID]bool
}

func (f *fakeSessions) List(_ context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error) {
	return append([]domain.Session(nil), f.byProject[filter.ProjectID]...), nil
}

func (f *fakeSessions) Kill(_ context.Context, id domain.SessionID) (bool, error) {
	f.killed = append(f.killed, id)
	if f.killNoop[id] {
		return false, nil
	}
	// Mark the session terminated in the fake so a re-list reflects the kill.
	for pid, list := range f.byProject {
		for i := range list {
			if list[i].ID == id {
				list[i].IsTerminated = true
				f.byProject[pid] = list
			}
		}
	}
	return true, nil
}

func worker(id domain.ProjectID, n string, status domain.SessionStatus) domain.Session {
	return domain.Session{
		SessionRecord: domain.SessionRecord{ID: domain.SessionID(string(id) + "-" + n), ProjectID: id, Kind: domain.KindWorker},
		Status:        status,
	}
}

func newSweeper(t *testing.T, store Store, sessions Sessions, sink ports.EventSink) *Sweeper {
	t.Helper()
	return New(store, sessions, Config{Telemetry: sink, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

type recordingSink struct {
	events  []ports.TelemetryEvent
	lastCtx context.Context
}

func (r *recordingSink) Emit(ctx context.Context, ev ports.TelemetryEvent) {
	r.lastCtx = ctx
	r.events = append(r.events, ev)
}
func (r *recordingSink) Close(context.Context) error { return nil }

// TestDrainTerminatesOnlyIdleOrDoneWorkers: a paused project's confirmed
// idle/merged workers are killed; actively-working, open-PR, needs-input, and
// crucially no-signal workers are left alone (no_signal is ambiguous — the
// agent may still be executing behind a broken hook).
func TestDrainTerminatesOnlyIdleOrDoneWorkers(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{ID: "mer", Paused: true}}}
	sessions := &fakeSessions{byProject: map[domain.ProjectID][]domain.Session{
		"mer": {
			worker("mer", "idle", domain.StatusIdle),
			worker("mer", "merged", domain.StatusMerged),
			worker("mer", "nosignal", domain.StatusNoSignal),
			worker("mer", "working", domain.StatusWorking),
			worker("mer", "propen", domain.StatusPROpen),
			worker("mer", "needsinput", domain.StatusNeedsInput),
		},
	}}
	sw := newSweeper(t, store, sessions, nil)
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	killed := map[domain.SessionID]bool{}
	for _, id := range sessions.killed {
		killed[id] = true
	}
	for _, want := range []domain.SessionID{"mer-idle", "mer-merged"} {
		if !killed[want] {
			t.Errorf("expected %s to be drained", want)
		}
	}
	// no_signal is NOT drainable: the agent may still be executing behind a
	// broken hook pipeline. Only --hard terminates it.
	for _, keep := range []domain.SessionID{"mer-working", "mer-propen", "mer-needsinput", "mer-nosignal"} {
		if killed[keep] {
			t.Errorf("%s must NOT be drained (still has work/PR/user wait, or unknown state)", keep)
		}
	}
}

// TestDrainSkipsRunningProjects: a project that is neither project- nor
// fleet-paused is never swept.
func TestDrainSkipsRunningProjects(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{ID: "run"}}}
	sessions := &fakeSessions{byProject: map[domain.ProjectID][]domain.Session{
		"run": {worker("run", "idle", domain.StatusIdle)},
	}}
	sw := newSweeper(t, store, sessions, nil)
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if len(sessions.killed) != 0 {
		t.Fatalf("running project must not be drained: %v", sessions.killed)
	}
}

// TestFleetPauseDrainsAllProjects: the global flag drives the drain even when a
// project's own bit is clear.
func TestFleetPauseDrainsAllProjects(t *testing.T) {
	store := &fakeStore{fleetPaused: true, projects: []domain.ProjectRecord{{ID: "a"}, {ID: "b"}}}
	sessions := &fakeSessions{byProject: map[domain.ProjectID][]domain.Session{
		"a": {worker("a", "idle", domain.StatusIdle)},
		"b": {worker("b", "idle", domain.StatusIdle)},
	}}
	sw := newSweeper(t, store, sessions, nil)
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if len(sessions.killed) != 2 {
		t.Fatalf("fleet pause should drain both projects, killed=%v", sessions.killed)
	}
}

// TestDrainCompleteEmitsOnceOnTransitionToZero: the drain-complete signal fires
// exactly once, when the last live worker is terminated — not on later ticks.
func TestDrainCompleteEmitsOnceOnTransitionToZero(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{ID: "mer", Paused: true}}}
	sessions := &fakeSessions{byProject: map[domain.ProjectID][]domain.Session{
		"mer": {
			worker("mer", "idle", domain.StatusIdle),
			worker("mer", "working", domain.StatusWorking),
		},
	}}
	sink := &recordingSink{}
	sw := newSweeper(t, store, sessions, sink)

	// Tick 1: idle worker drained, one still working → not complete, no signal.
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick 1: %v", err)
	}
	if len(sink.events) != 0 {
		t.Fatalf("no drain-complete while a worker is still live, got %d", len(sink.events))
	}

	// The remaining worker goes idle; tick 2 drains it → complete signal fires.
	list := sessions.byProject["mer"]
	for i := range list {
		if list[i].ID == "mer-working" {
			list[i].Status = domain.StatusIdle
		}
	}
	sessions.byProject["mer"] = list
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick 2: %v", err)
	}
	if len(sink.events) != 1 || sink.events[0].Name != "ao.fleet.drain_complete" {
		t.Fatalf("expected one drain_complete after last worker drained, got %#v", sink.events)
	}

	// Tick 3: nothing live, already signalled → no duplicate.
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick 3: %v", err)
	}
	if len(sink.events) != 1 {
		t.Fatalf("drain-complete must not re-fire, got %d", len(sink.events))
	}
}

// TestDrainKillNoopCountsAsLive: a Kill that no-ops (dirty worktree preserved)
// leaves the worker counted as live, so drain-complete does not fire prematurely.
func TestDrainKillNoopCountsAsLive(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{ID: "mer", Paused: true}}}
	sessions := &fakeSessions{
		byProject: map[domain.ProjectID][]domain.Session{
			"mer": {worker("mer", "dirty", domain.StatusIdle)},
		},
		killNoop: map[domain.SessionID]bool{"mer-dirty": true},
	}
	sink := &recordingSink{}
	sw := newSweeper(t, store, sessions, sink)
	if err := sw.Tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if len(sink.events) != 0 {
		t.Fatalf("a preserved (kill no-op) worker must count as live; no drain-complete expected, got %d", len(sink.events))
	}
}

// TestDrainCompleteEmitUsesTickContext: the drain-complete telemetry is emitted
// with the tick's context, not a detached context.Background(), so it honors
// daemon-shutdown cancellation instead of blocking or emitting after the poll
// loop has stopped. Regression for the Copilot review finding on drain.go.
func TestDrainCompleteEmitUsesTickContext(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{ID: "mer", Paused: true}}}
	sessions := &fakeSessions{byProject: map[domain.ProjectID][]domain.Session{
		"mer": {worker("mer", "idle", domain.StatusIdle)},
	}}
	sink := &recordingSink{}
	sw := newSweeper(t, store, sessions, sink)

	type ctxKey string
	const key ctxKey = "tick-marker"
	ctx := context.WithValue(context.Background(), key, "present")
	if err := sw.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if len(sink.events) != 1 {
		t.Fatalf("expected one drain_complete, got %d", len(sink.events))
	}
	if sink.lastCtx == nil || sink.lastCtx.Value(key) != "present" {
		t.Fatalf("drain-complete must be emitted with the tick context (carrying cancellation), not context.Background()")
	}
}
