package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestOrchestratorReengagementPersistence(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	rec := sampleRecord("p")
	rec.Kind = domain.KindOrchestrator
	rec, err := s.CreateSession(ctx, rec)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	if err := s.ScheduleOrchestratorReengagement(ctx, rec.ID, now.Add(time.Minute), now); err != nil {
		t.Fatal(err)
	}
	state, ok, err := s.GetOrchestratorReengagement(ctx, rec.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if state.AttemptCount != 0 || state.State != domain.OrchestratorReengagementActive {
		t.Fatalf("initial state = %#v", state)
	}
	state, err = s.RecordOrchestratorReengagementAttempt(ctx, rec.ID, now.Add(2*time.Minute), now, 3)
	if err != nil {
		t.Fatal(err)
	}
	if state.AttemptCount != 1 || state.State != domain.OrchestratorReengagementActive {
		t.Fatalf("attempt state = %#v", state)
	}
	if err := s.MarkOrchestratorReengagementProgress(ctx, rec.ID, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.ScheduleOrchestratorReengagement(ctx, rec.ID, now.Add(5*time.Minute), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	state, _, err = s.GetOrchestratorReengagement(ctx, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.AttemptCount != 0 || state.ProgressSinceAttempt || !state.NextAttemptAt.Equal(now.Add(5*time.Minute)) {
		t.Fatalf("reset state = %#v", state)
	}
	if _, err := s.CompleteOrchestratorReengagement(ctx, rec.ID, now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkOrchestratorReengagementProgress(ctx, rec.ID, now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.ScheduleOrchestratorReengagement(ctx, rec.ID, now.Add(10*time.Minute), now.Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	state, _, err = s.GetOrchestratorReengagement(ctx, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.State != domain.OrchestratorReengagementCompleted {
		t.Fatalf("completed state was rearmed: %#v", state)
	}
}
