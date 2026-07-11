package project_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func pauseTestStore(t *testing.T) *sqlite.Store {
	t.Helper()
	s, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func seedPauseProject(t *testing.T, s *sqlite.Store, id string) {
	t.Helper()
	if err := s.UpsertProject(context.Background(), domain.ProjectRecord{
		ID: id, Path: "/tmp/" + id, RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project %s: %v", id, err)
	}
}

func seedWorker(t *testing.T, s *sqlite.Store, project string) domain.SessionRecord {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	rec, err := s.CreateSession(context.Background(), domain.SessionRecord{
		ProjectID: domain.ProjectID(project),
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("seed worker for %s: %v", project, err)
	}
	return rec
}

func summaryByID(list []project.Summary, id string) project.Summary {
	for _, s := range list {
		if string(s.ID) == id {
			return s
		}
	}
	return project.Summary{}
}

// TestListReportsRunningDrainingPaused walks a project through the observable
// lifecycle: running → (pause with a live worker) draining → (worker gone)
// paused, while an unpaused peer stays running throughout.
func TestListReportsRunningDrainingPaused(t *testing.T) {
	store := pauseTestStore(t)
	m := project.New(store)
	ctx := context.Background()
	seedPauseProject(t, store, "a")
	seedPauseProject(t, store, "b")

	// Both running initially.
	list, err := m.List(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := summaryByID(list, "a"); got.PauseState != project.PauseStateRunning || got.Paused {
		t.Fatalf("a initial = %+v, want running/not-paused", got)
	}

	// Pause 'a' with one live worker → draining(1).
	worker := seedWorker(t, store, "a")
	if _, err := m.SetProjectPaused(ctx, "a", true, false); err != nil {
		t.Fatalf("pause a: %v", err)
	}
	list, _ = m.List(ctx)
	if got := summaryByID(list, "a"); got.PauseState != project.PauseStateDraining || got.DrainingWorkers != 1 || !got.Paused {
		t.Fatalf("a after pause = %+v, want draining(1)/paused", got)
	}
	if got := summaryByID(list, "b"); got.PauseState != project.PauseStateRunning {
		t.Fatalf("b = %+v, want still running", got)
	}

	// Worker terminates → drained → paused(0).
	worker.IsTerminated = true
	if err := store.UpdateSession(ctx, worker); err != nil {
		t.Fatalf("terminate worker: %v", err)
	}
	list, _ = m.List(ctx)
	if got := summaryByID(list, "a"); got.PauseState != project.PauseStatePaused || got.DrainingWorkers != 0 {
		t.Fatalf("a after drain = %+v, want paused(0)", got)
	}
}

// TestFleetPauseGatesEveryProject: the daemon-global flag makes every project
// read paused even though none has its own bit set — including the drain
// distinction. This is the distinct-global-flag behavior (a new project is
// gated without an individual bit).
func TestFleetPauseGatesEveryProject(t *testing.T) {
	store := pauseTestStore(t)
	m := project.New(store)
	ctx := context.Background()
	seedPauseProject(t, store, "a")
	seedPauseProject(t, store, "b")
	seedWorker(t, store, "a") // a has a live worker → draining under fleet pause

	if err := m.SetFleetPaused(ctx, true, false); err != nil {
		t.Fatalf("set fleet paused: %v", err)
	}
	if paused, _ := m.FleetPaused(ctx); !paused {
		t.Fatal("FleetPaused should report true after SetFleetPaused(true)")
	}

	list, _ := m.List(ctx)
	if got := summaryByID(list, "a"); got.PauseState != project.PauseStateDraining || got.Paused {
		t.Fatalf("a under fleet pause = %+v, want draining but own bit false", got)
	}
	if got := summaryByID(list, "b"); got.PauseState != project.PauseStatePaused || got.Paused {
		t.Fatalf("b under fleet pause = %+v, want paused but own bit false", got)
	}

	// Resuming the fleet returns everything to running.
	if err := m.SetFleetPaused(ctx, false, false); err != nil {
		t.Fatalf("resume fleet: %v", err)
	}
	list, _ = m.List(ctx)
	if got := summaryByID(list, "b"); got.PauseState != project.PauseStateRunning {
		t.Fatalf("b after fleet resume = %+v, want running", got)
	}
}

// TestSetProjectPausedReturnsUpdatedDetail: the pause mutation returns a detail
// whose paused bit and state reflect the change, and resume clears it.
func TestSetProjectPausedReturnsUpdatedDetail(t *testing.T) {
	store := pauseTestStore(t)
	m := project.New(store)
	ctx := context.Background()
	seedPauseProject(t, store, "a")

	p, err := m.SetProjectPaused(ctx, "a", true, false)
	if err != nil {
		t.Fatalf("pause: %v", err)
	}
	if !p.Paused || p.PauseState != project.PauseStatePaused {
		t.Fatalf("paused detail = %+v, want paused/true", p)
	}
	p, err = m.SetProjectPaused(ctx, "a", false, false)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if p.Paused || p.PauseState != project.PauseStateRunning {
		t.Fatalf("resumed detail = %+v, want running/false", p)
	}
}

// TestHardPauseTerminatesProjectWorkers: a --hard project pause terminates the
// project's workers immediately (orchestrators excluded); a soft pause does not.
func TestHardPauseTerminatesProjectWorkers(t *testing.T) {
	store := pauseTestStore(t)
	ops := &fakeSessionOps{}
	m := project.NewWithDeps(project.Deps{Store: store, Sessions: ops})
	ctx := context.Background()
	seedPauseProject(t, store, "a")

	if _, err := m.SetProjectPaused(ctx, "a", true, true); err != nil {
		t.Fatalf("hard pause: %v", err)
	}
	if len(ops.hardDrain) != 1 || ops.hardDrain[0].project != "a" || ops.hardDrain[0].includeOrchestrators {
		t.Fatalf("hard pause drain calls = %+v, want one for 'a' excluding orchestrators", ops.hardDrain)
	}

	// A soft pause must NOT terminate anything.
	if _, err := m.SetProjectPaused(ctx, "a", true, false); err != nil {
		t.Fatalf("soft pause: %v", err)
	}
	if len(ops.hardDrain) != 1 {
		t.Fatalf("soft pause must not hard-drain, calls = %+v", ops.hardDrain)
	}
}

// TestHardFleetPauseTerminatesEveryProjectIncludingOrchestrators: --hard --all
// terminates every project's sessions, orchestrators included.
func TestHardFleetPauseTerminatesEveryProjectIncludingOrchestrators(t *testing.T) {
	store := pauseTestStore(t)
	ops := &fakeSessionOps{}
	m := project.NewWithDeps(project.Deps{Store: store, Sessions: ops})
	ctx := context.Background()
	seedPauseProject(t, store, "a")
	seedPauseProject(t, store, "b")

	if err := m.SetFleetPaused(ctx, true, true); err != nil {
		t.Fatalf("hard fleet pause: %v", err)
	}
	if len(ops.hardDrain) != 2 {
		t.Fatalf("hard fleet pause drain calls = %d, want one per project", len(ops.hardDrain))
	}
	for _, call := range ops.hardDrain {
		if !call.includeOrchestrators {
			t.Fatalf("fleet hard pause must include orchestrators, got %+v", call)
		}
	}

	// A soft fleet pause terminates nothing.
	ops.hardDrain = nil
	if err := m.SetFleetPaused(ctx, true, false); err != nil {
		t.Fatalf("soft fleet pause: %v", err)
	}
	if len(ops.hardDrain) != 0 {
		t.Fatalf("soft fleet pause must not hard-drain, calls = %+v", ops.hardDrain)
	}
}

// TestSetProjectPausedUnknownProject: pausing an unknown project is a typed 404.
func TestSetProjectPausedUnknownProject(t *testing.T) {
	store := pauseTestStore(t)
	m := project.New(store)
	if _, err := m.SetProjectPaused(context.Background(), "ghost", true, false); err == nil {
		t.Fatal("pausing unknown project should error")
	}
}
