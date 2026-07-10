package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// TelemetryEventRecord is the store-facing representation of a telemetry row.
type TelemetryEventRecord struct {
	ID          string
	OccurredAt  time.Time
	Name        string
	Source      string
	Level       string
	ProjectID   *domain.ProjectID
	SessionID   *domain.SessionID
	RequestID   string
	PayloadJSON string
}

// CreateTelemetryEvent persists one telemetry event row.
func (s *Store) CreateTelemetryEvent(ctx context.Context, rec TelemetryEventRecord) error {
	arg := gen.CreateTelemetryEventParams{
		ID:          rec.ID,
		OccurredAt:  rec.OccurredAt.UTC(),
		Name:        rec.Name,
		Source:      rec.Source,
		Level:       rec.Level,
		RequestID:   rec.RequestID,
		PayloadJson: rec.PayloadJSON,
	}
	if rec.ProjectID != nil {
		arg.ProjectID = sql.NullString{String: string(*rec.ProjectID), Valid: true}
	}
	if rec.SessionID != nil {
		arg.SessionID = sql.NullString{String: string(*rec.SessionID), Valid: true}
	}
	if err := s.qw.CreateTelemetryEvent(ctx, arg); err != nil {
		return fmt.Errorf("create telemetry event %s: %w", rec.ID, err)
	}
	return nil
}

// ListTelemetryEventsSince returns telemetry rows oldest-first from a time
// boundary, capped by limit.
func (s *Store) ListTelemetryEventsSince(ctx context.Context, since time.Time, limit int64) ([]gen.TelemetryEvent, error) {
	rows, err := s.qr.ListTelemetryEventsSince(ctx, gen.ListTelemetryEventsSinceParams{
		OccurredAt: since.UTC(),
		Limit:      limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list telemetry events since %s: %w", since.UTC().Format(time.RFC3339), err)
	}
	return rows, nil
}

// PruneTelemetryEventsBefore deletes at most limit rows older than before and
// returns how many rows were removed.
// ListCostTelemetryEventsSince returns only telemetry rows that contain one of
// the cost-bearing payload keys the metrics observer aggregates, newest-first
// from a time boundary and capped by limit. Filtering in SQL keeps unrelated
// operational telemetry from starving the cost aggregate's bounded scan.
func (s *Store) ListCostTelemetryEventsSince(ctx context.Context, since time.Time, limit int64) ([]gen.TelemetryEvent, error) {
	rows, err := s.qr.ListCostTelemetryEventsSince(ctx, gen.ListCostTelemetryEventsSinceParams{
		OccurredAt: since.UTC(),
		Limit:      limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list cost telemetry events since %s: %w", since.UTC().Format(time.RFC3339), err)
	}
	return rows, nil
}

func (s *Store) PruneTelemetryEventsBefore(ctx context.Context, before time.Time, limit int64) (int64, error) {
	n, err := s.qw.PruneTelemetryEventsBefore(ctx, gen.PruneTelemetryEventsBeforeParams{
		OccurredAt: before.UTC(),
		Limit:      limit,
	})
	if err != nil {
		return 0, fmt.Errorf("prune telemetry events before %s: %w", before.UTC().Format(time.RFC3339), err)
	}
	return n, nil
}
