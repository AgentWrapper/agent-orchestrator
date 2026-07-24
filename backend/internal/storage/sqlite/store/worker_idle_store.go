package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// RecordWorkerIdle persists a worker's activity transition and its worker_idle
// outbox event in one transaction, so a crash can't save the worker idle while
// losing the pending delivery. Repeated completions for the same worker coalesce
// onto the single pending row.
func (s *Store) RecordWorkerIdle(ctx context.Context, rec domain.SessionRecord, ev domain.WorkerIdleEvent) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "record worker idle", func(q *gen.Queries) error {
		if err := q.UpdateSession(ctx, recordToUpdate(rec)); err != nil {
			return fmt.Errorf("update session %s: %w", rec.ID, err)
		}
		existing, err := q.GetPendingWorkerIdleEventByWorker(ctx, ev.WorkerID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("lookup pending worker idle %s: %w", ev.WorkerID, err)
		}
		if err == nil {
			return q.TouchWorkerIdleEvent(ctx, gen.TouchWorkerIdleEventParams{
				TransitionAt: ev.TransitionAt,
				UpdatedAt:    ev.CreatedAt,
				ID:           existing.ID,
			})
		}
		return q.InsertWorkerIdleEvent(ctx, gen.InsertWorkerIdleEventParams{
			ID:           ev.ID,
			ProjectID:    ev.ProjectID,
			WorkerID:     ev.WorkerID,
			TransitionAt: ev.TransitionAt,
			CreatedAt:    ev.CreatedAt,
			UpdatedAt:    ev.CreatedAt,
		})
	})
}

// ListPendingWorkerIdleEventsByProject returns undelivered worker_idle events
// for a project, oldest transition first.
func (s *Store) ListPendingWorkerIdleEventsByProject(ctx context.Context, project domain.ProjectID) ([]domain.WorkerIdleEvent, error) {
	rows, err := s.qr.ListPendingWorkerIdleEventsByProject(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list pending worker idle for %s: %w", project, err)
	}
	return workerIdleEventsFromGen(rows), nil
}

// ListPendingWorkerIdleEvents returns every undelivered worker_idle event across
// projects — the daemon-start and recovery-sweep entry point.
func (s *Store) ListPendingWorkerIdleEvents(ctx context.Context) ([]domain.WorkerIdleEvent, error) {
	rows, err := s.qr.ListPendingWorkerIdleEvents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list pending worker idle: %w", err)
	}
	return workerIdleEventsFromGen(rows), nil
}

// MarkWorkerIdleEventDelivered marks one event delivered. Called only after the
// guard reports a pane write was attempted.
func (s *Store) MarkWorkerIdleEventDelivered(ctx context.Context, id string, at time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.MarkWorkerIdleEventDelivered(ctx, gen.MarkWorkerIdleEventDeliveredParams{UpdatedAt: at, ID: id}); err != nil {
		return fmt.Errorf("mark worker idle delivered %s: %w", id, err)
	}
	return nil
}

func workerIdleEventFromGen(row gen.WorkerIdleEvent) domain.WorkerIdleEvent {
	return domain.WorkerIdleEvent{
		ID:           row.ID,
		ProjectID:    row.ProjectID,
		WorkerID:     row.WorkerID,
		TransitionAt: row.TransitionAt,
		CreatedAt:    row.CreatedAt,
	}
}

func workerIdleEventsFromGen(rows []gen.WorkerIdleEvent) []domain.WorkerIdleEvent {
	out := make([]domain.WorkerIdleEvent, 0, len(rows))
	for _, row := range rows {
		out = append(out, workerIdleEventFromGen(row))
	}
	return out
}
