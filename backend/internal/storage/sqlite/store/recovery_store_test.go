package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func recoveryIncident(now time.Time) domain.RecoveryIncident {
	return domain.RecoveryIncident{
		ID:                    "recovery_abc",
		ProjectID:             "ao",
		IssueID:               "github:polymath-ventures/agent-orchestrator#321",
		Fingerprint:           "sha256:abc",
		Status:                domain.RecoveryIncidentOpen,
		Rung:                  domain.RecoveryRungWorker,
		Attempt:               1,
		DeadSessionID:         "ao-1",
		LastSessionID:         "ao-1",
		TerminalFailureReason: "runtime probe reported dead",
		FailurePoint:          "activity=active;open_pr=none",
		CreatedAt:             now,
		UpdatedAt:             now,
	}
}

func TestRecoveryIncidentStoreCreateGetUpdate(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	now := time.Date(2026, 7, 15, 1, 2, 3, 0, time.UTC)

	created, err := s.CreateRecoveryIncident(ctx, recoveryIncident(now))
	if err != nil {
		t.Fatalf("create recovery incident: %v", err)
	}
	got, ok, err := s.GetUnresolvedRecoveryIncidentByFingerprint(ctx, "ao", created.IssueID, created.Fingerprint)
	if err != nil || !ok {
		t.Fatalf("get unresolved: ok=%v err=%v", ok, err)
	}
	if got.ID != created.ID || got.Attempt != 1 || got.Rung != domain.RecoveryRungWorker || got.TerminalFailureReason != "runtime probe reported dead" {
		t.Fatalf("incident round trip = %+v", got)
	}

	got.Attempt = 2
	got.Rung = domain.RecoveryRungOrc
	got.LastSessionID = "ao-2"
	got.DeadSessionID = "ao-2"
	got.Diagnosis = "first fix failed"
	got.LastFailedFixReference = "PR #400"
	got.UpdatedAt = now.Add(time.Minute)
	updated, ok, err := s.UpdateRecoveryIncident(ctx, got)
	if err != nil || !ok {
		t.Fatalf("update recovery incident: ok=%v err=%v", ok, err)
	}
	if updated.Attempt != 2 || updated.Rung != domain.RecoveryRungOrc || updated.Diagnosis != "first fix failed" || updated.LastFailedFixReference != "PR #400" {
		t.Fatalf("updated incident = %+v", updated)
	}

	bySession, err := s.ListUnresolvedRecoveryIncidentsBySession(ctx, "ao-2")
	if err != nil {
		t.Fatalf("list by session: %v", err)
	}
	if len(bySession) != 1 || bySession[0].ID != created.ID {
		t.Fatalf("by session = %+v", bySession)
	}

	got.Status = domain.RecoveryIncidentVerifying
	got.FixReference = "PR #400"
	got.VerificationSessionID = "ao-verify"
	got.UpdatedAt = now.Add(2 * time.Minute)
	updated, ok, err = s.UpdateRecoveryIncident(ctx, got)
	if err != nil || !ok {
		t.Fatalf("mark verifying: ok=%v err=%v", ok, err)
	}
	byVerification, err := s.ListUnresolvedRecoveryIncidentsBySession(ctx, "ao-verify")
	if err != nil {
		t.Fatalf("list by verification session: %v", err)
	}
	if len(byVerification) != 1 || byVerification[0].ID != updated.ID {
		t.Fatalf("by verification session = %+v", byVerification)
	}
}

func TestRecoveryIncidentStoreConditionalUpdate(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	now := time.Date(2026, 7, 15, 1, 2, 3, 0, time.UTC)

	created, err := s.CreateRecoveryIncident(ctx, recoveryIncident(now))
	if err != nil {
		t.Fatalf("create recovery incident: %v", err)
	}
	claimed := created
	claimed.Status = domain.RecoveryIncidentVerifying
	claimed.FixReference = "PR #400"
	claimed.UpdatedAt = now.Add(time.Minute)
	if _, ok, err := s.UpdateRecoveryIncidentIfUnchanged(ctx, claimed, created); err != nil || !ok {
		t.Fatalf("conditional claim: ok=%v err=%v", ok, err)
	}
	stale := created
	stale.FixReference = "PR #401"
	stale.UpdatedAt = now.Add(2 * time.Minute)
	if _, ok, err := s.UpdateRecoveryIncidentIfUnchanged(ctx, stale, created); err != nil || ok {
		t.Fatalf("stale conditional update: ok=%v err=%v, want stale miss", ok, err)
	}
}

func TestRecoveryIncidentStoreUniqueOnlyWhileUnresolved(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	now := time.Date(2026, 7, 15, 1, 2, 3, 0, time.UTC)
	rec := recoveryIncident(now)
	if _, err := s.CreateRecoveryIncident(ctx, rec); err != nil {
		t.Fatalf("create first: %v", err)
	}
	if _, err := s.CreateRecoveryIncident(ctx, rec); err == nil {
		t.Fatal("duplicate unresolved fingerprint was accepted")
	}
	rec.Status = domain.RecoveryIncidentResolved
	rec.ResolvedAt = now.Add(time.Minute)
	rec.UpdatedAt = rec.ResolvedAt
	if _, ok, err := s.UpdateRecoveryIncident(ctx, rec); err != nil || !ok {
		t.Fatalf("resolve first: ok=%v err=%v", ok, err)
	}
	rec.ID = "recovery_def"
	rec.Status = domain.RecoveryIncidentOpen
	rec.ResolvedAt = time.Time{}
	rec.UpdatedAt = now.Add(2 * time.Minute)
	if _, err := s.CreateRecoveryIncident(ctx, rec); err != nil {
		t.Fatalf("create second after resolve: %v", err)
	}
}
