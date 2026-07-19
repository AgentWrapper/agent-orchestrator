package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
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
