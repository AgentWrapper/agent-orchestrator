package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestWorkerIdleStore_AtomicRecordCoalesceAndDeliver(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	worker, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)

	idle := worker
	idle.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	idle.UpdatedAt = now
	ev := domain.WorkerIdleEvent{ID: "wie_1", ProjectID: worker.ProjectID, WorkerID: worker.ID, TransitionAt: now, CreatedAt: now}
	if err := s.RecordWorkerIdle(ctx, idle, ev); err != nil {
		t.Fatalf("RecordWorkerIdle: %v", err)
	}

	// Atomic: the session write landed alongside the event.
	got, ok, err := s.GetSession(ctx, worker.ID)
	if err != nil || !ok {
		t.Fatalf("GetSession ok=%v err=%v", ok, err)
	}
	if got.Activity.State != domain.ActivityIdle {
		t.Fatalf("session state = %q, want idle", got.Activity.State)
	}

	// Coalesce: a second completion for the same worker keeps one pending row.
	ev2 := domain.WorkerIdleEvent{ID: "wie_2", ProjectID: worker.ProjectID, WorkerID: worker.ID, TransitionAt: now.Add(time.Minute), CreatedAt: now.Add(time.Minute)}
	if err := s.RecordWorkerIdle(ctx, idle, ev2); err != nil {
		t.Fatalf("RecordWorkerIdle 2: %v", err)
	}
	pending, err := s.ListPendingWorkerIdleEventsByProject(ctx, worker.ProjectID)
	if err != nil {
		t.Fatalf("ListPendingByProject: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("pending events = %d, want 1 (coalesced)", len(pending))
	}

	all, err := s.ListPendingWorkerIdleEvents(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("ListPending all = %d err=%v, want 1", len(all), err)
	}

	// Delivery removes it from the pending set.
	if err := s.MarkWorkerIdleEventDelivered(ctx, pending[0].ID, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}
	pending, err = s.ListPendingWorkerIdleEventsByProject(ctx, worker.ProjectID)
	if err != nil {
		t.Fatalf("ListPendingByProject after deliver: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending after deliver = %d, want 0", len(pending))
	}
}

// TestWorkerIdleStore_PendingSurvivesReopen closes the database and reopens it,
// proving a pending completion outlives a daemon restart.
func TestWorkerIdleStore_PendingSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	first, err := sqlite.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	seedProject(t, first, "mer")
	worker, err := first.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	idle := worker
	idle.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	idle.UpdatedAt = now
	if err := first.RecordWorkerIdle(ctx, idle, domain.WorkerIdleEvent{ID: "wie_1", ProjectID: worker.ProjectID, WorkerID: worker.ID, TransitionAt: now, CreatedAt: now}); err != nil {
		t.Fatalf("RecordWorkerIdle: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	reopened, err := sqlite.Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	pending, err := reopened.ListPendingWorkerIdleEvents(ctx)
	if err != nil {
		t.Fatalf("ListPending after reopen: %v", err)
	}
	if len(pending) != 1 || pending[0].WorkerID != worker.ID {
		t.Fatalf("pending after reopen = %+v, want the recorded event for %s", pending, worker.ID)
	}
}

// TestWorkerIdleStore_EventFailureRollsBackWorkerState forces the outbox insert
// to fail (duplicate event id) and asserts the worker's activity write rolled
// back with it — the atomicity guarantee.
func TestWorkerIdleStore_EventFailureRollsBackWorkerState(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	first, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create first session: %v", err)
	}
	second, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create second session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)

	firstIdle := first
	firstIdle.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	firstIdle.UpdatedAt = now
	if err := s.RecordWorkerIdle(ctx, firstIdle, domain.WorkerIdleEvent{ID: "wie_dup", ProjectID: first.ProjectID, WorkerID: first.ID, TransitionAt: now, CreatedAt: now}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	// Same event id for a different worker: the insert violates the primary key.
	secondIdle := second
	secondIdle.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	secondIdle.UpdatedAt = now
	if err := s.RecordWorkerIdle(ctx, secondIdle, domain.WorkerIdleEvent{ID: "wie_dup", ProjectID: second.ProjectID, WorkerID: second.ID, TransitionAt: now, CreatedAt: now}); err == nil {
		t.Fatal("RecordWorkerIdle with a duplicate event id succeeded, want error")
	}

	got, ok, err := s.GetSession(ctx, second.ID)
	if err != nil || !ok {
		t.Fatalf("GetSession ok=%v err=%v", ok, err)
	}
	if got.Activity.State != domain.ActivityActive {
		t.Fatalf("worker state = %q after failed event write, want the original active (rollback)", got.Activity.State)
	}
	pending, err := s.ListPendingWorkerIdleEventsByProject(ctx, "mer")
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if len(pending) != 1 || pending[0].WorkerID != first.ID {
		t.Fatalf("pending = %+v, want only the first worker's event", pending)
	}
}

// TestWorkerIdleStore_CoalesceRunsInTheSameTransaction covers the branch the
// insert test cannot reach: when a pending row already exists, RecordWorkerIdle
// takes the coalesce (touch) path. Failing the session write in that same call
// must leave the existing event untouched, proving both statements share one
// transaction rather than only the insert path being atomic.
func TestWorkerIdleStore_CoalesceRunsInTheSameTransaction(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	worker, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	first := time.Now().UTC().Truncate(time.Second)

	idle := worker
	idle.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: first}
	idle.UpdatedAt = first
	if err := s.RecordWorkerIdle(ctx, idle, domain.WorkerIdleEvent{ID: "wie_1", ProjectID: worker.ProjectID, WorkerID: worker.ID, TransitionAt: first, CreatedAt: first}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	// Second completion for the same worker → coalesce path, but the session
	// write violates the sessions.harness CHECK and aborts the transaction.
	second := first.Add(time.Hour)
	bad := idle
	bad.Harness = "not-a-real-harness"
	bad.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: second}
	bad.UpdatedAt = second
	if err := s.RecordWorkerIdle(ctx, bad, domain.WorkerIdleEvent{ID: "wie_2", ProjectID: worker.ProjectID, WorkerID: worker.ID, TransitionAt: second, CreatedAt: second}); err == nil {
		t.Fatal("RecordWorkerIdle with an invalid harness succeeded, want error")
	}

	pending, err := s.ListPendingWorkerIdleEventsByProject(ctx, worker.ProjectID)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("pending = %d, want 1", len(pending))
	}
	if !pending[0].TransitionAt.Equal(first) {
		t.Fatalf("coalesce touch survived the aborted transaction: transition_at = %s, want %s", pending[0].TransitionAt, first)
	}
	got, ok, err := s.GetSession(ctx, worker.ID)
	if err != nil || !ok {
		t.Fatalf("GetSession ok=%v err=%v", ok, err)
	}
	if got.Harness != worker.Harness {
		t.Fatalf("harness = %q after aborted write, want the original %q", got.Harness, worker.Harness)
	}
}

// TestWorkerIdleStore_DeletingWorkerDropsPendingEvent pins the intended cascade
// semantic: the event's only instruction is to inspect that worker, so removing
// the worker makes an undelivered completion obsolete rather than retryable.
func TestWorkerIdleStore_DeletingWorkerDropsPendingEvent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	// A seed row (no workspace/handle/prompt) is the only shape DeleteSession removes.
	seed := sampleRecord("mer")
	seed.Metadata = domain.SessionMetadata{}
	worker, err := s.CreateSession(ctx, seed)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.RecordWorkerIdle(ctx, worker, domain.WorkerIdleEvent{ID: "wie_1", ProjectID: worker.ProjectID, WorkerID: worker.ID, TransitionAt: now, CreatedAt: now}); err != nil {
		t.Fatalf("RecordWorkerIdle: %v", err)
	}

	deleted, err := s.DeleteSession(ctx, worker.ID)
	if err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if !deleted {
		t.Fatal("seed session was not deleted; cascade semantic untested")
	}
	pending, err := s.ListPendingWorkerIdleEvents(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending after worker delete = %+v, want none (cascade)", pending)
	}
}
