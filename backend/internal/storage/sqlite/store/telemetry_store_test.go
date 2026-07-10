package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func TestTelemetryStore_CreateListAndPrune(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	projectID := domain.ProjectID("mer")
	sessionID := domain.SessionID("mer-1")
	seedProject(t, s, string(projectID))

	oldAt := time.Now().UTC().Add(-31 * 24 * time.Hour).Truncate(time.Second)
	newAt := time.Now().UTC().Truncate(time.Second)

	if err := s.CreateTelemetryEvent(ctx, telemetryRecord("tev_old", oldAt, &projectID, &sessionID)); err != nil {
		t.Fatalf("CreateTelemetryEvent old: %v", err)
	}
	if err := s.CreateTelemetryEvent(ctx, telemetryRecord("tev_new", newAt, &projectID, &sessionID)); err != nil {
		t.Fatalf("CreateTelemetryEvent new: %v", err)
	}

	rows, err := s.ListTelemetryEventsSince(ctx, oldAt.Add(-time.Second), 10)
	if err != nil {
		t.Fatalf("ListTelemetryEventsSince: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	// Newest-first: the most recent event comes first so a truncating LIMIT keeps
	// the newest rows.
	if rows[0].ID != "tev_new" || rows[1].ID != "tev_old" {
		t.Fatalf("ids = %q, %q (want newest-first)", rows[0].ID, rows[1].ID)
	}

	n, err := s.PruneTelemetryEventsBefore(ctx, newAt.Add(-24*time.Hour), 100)
	if err != nil {
		t.Fatalf("PruneTelemetryEventsBefore: %v", err)
	}
	if n != 1 {
		t.Fatalf("pruned = %d, want 1", n)
	}

	rows, err = s.ListTelemetryEventsSince(ctx, oldAt.Add(-time.Second), 10)
	if err != nil {
		t.Fatalf("ListTelemetryEventsSince after prune: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "tev_new" {
		t.Fatalf("remaining rows = %+v", rows)
	}
}

func TestTelemetryStore_ListLimitZeroMeansNoRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	projectID := domain.ProjectID("mer")
	seedProject(t, s, string(projectID))
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.CreateTelemetryEvent(ctx, telemetryRecord("tev_1", now, &projectID, nil)); err != nil {
		t.Fatalf("CreateTelemetryEvent: %v", err)
	}

	rows, err := s.ListTelemetryEventsSince(ctx, now.Add(-time.Second), 0)
	if err != nil {
		t.Fatalf("ListTelemetryEventsSince limit 0: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("limit 0 must return no rows, got %+v", rows)
	}
}

func TestTelemetryStore_ListCostTelemetryFiltersBeforeLimit(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	projectID := domain.ProjectID("mer")
	seedProject(t, s, string(projectID))
	now := time.Now().UTC().Truncate(time.Second)

	// Newer non-cost events should not consume the bounded cost aggregate query's
	// LIMIT and starve the older cost-bearing rows.
	for i := 0; i < 3; i++ {
		rec := telemetryRecord("tev_noise_"+string(rune('a'+i)), now.Add(time.Duration(i)*time.Second), &projectID, nil)
		rec.PayloadJSON = `{"port":3001}`
		if err := s.CreateTelemetryEvent(ctx, rec); err != nil {
			t.Fatalf("CreateTelemetryEvent noise %d: %v", i, err)
		}
	}
	costOld := telemetryRecord("tev_cost_old", now.Add(-time.Minute), &projectID, nil)
	costOld.PayloadJSON = `{"input_tokens":10}`
	if err := s.CreateTelemetryEvent(ctx, costOld); err != nil {
		t.Fatalf("CreateTelemetryEvent cost old: %v", err)
	}
	costNew := telemetryRecord("tev_cost_new", now.Add(-30*time.Second), &projectID, nil)
	costNew.PayloadJSON = `{"cost_usd":0.01}`
	if err := s.CreateTelemetryEvent(ctx, costNew); err != nil {
		t.Fatalf("CreateTelemetryEvent cost new: %v", err)
	}

	rows, err := s.ListCostTelemetryEventsSince(ctx, now.Add(-2*time.Minute), 2)
	if err != nil {
		t.Fatalf("ListCostTelemetryEventsSince: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("cost rows = %d, want 2: %+v", len(rows), rows)
	}
	if rows[0].ID != "tev_cost_new" || rows[1].ID != "tev_cost_old" {
		t.Fatalf("cost ids = %q, %q; want newest cost rows only", rows[0].ID, rows[1].ID)
	}
}

func telemetryRecord(id string, at time.Time, projectID *domain.ProjectID, sessionID *domain.SessionID) sqlitestore.TelemetryEventRecord {
	return sqlitestore.TelemetryEventRecord{
		ID:          id,
		OccurredAt:  at,
		Name:        "ao.daemon.started",
		Source:      "daemon",
		Level:       "info",
		ProjectID:   projectID,
		SessionID:   sessionID,
		RequestID:   "req_123",
		PayloadJSON: `{"port":3001}`,
	}
}
