package project_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/agenthealth"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

type workerCapacityStore struct {
	project  domain.ProjectRecord
	sessions []domain.SessionRecord
}

func (s workerCapacityStore) GetProject(context.Context, string) (domain.ProjectRecord, bool, error) {
	return s.project, true, nil
}

func (s workerCapacityStore) ListSessions(context.Context, domain.ProjectID) ([]domain.SessionRecord, error) {
	return s.sessions, nil
}

type workerCapacityHealth struct{ snapshot agenthealth.Snapshot }

func (h workerCapacityHealth) Snapshot() agenthealth.Snapshot { return h.snapshot }

func TestWorkerCapacityReportsMixAllocationAndDegradedCapacity(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	svc := project.NewWorkerCapacity(workerCapacityStore{
		project: domain.ProjectRecord{
			ID: "ao",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, MaxConcurrent: 10},
				WorkerMix: domain.WorkerMix{
					{Harness: domain.HarnessCodex, Weight: 70},
					{Harness: domain.HarnessClaudeCode, Model: "claude-opus-4-8", Weight: 30},
				},
			},
		},
		sessions: []domain.SessionRecord{
			{ID: "ao-1", ProjectID: "ao", IssueID: "github:polymath-ventures/agent-orchestrator#1", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
			{ID: "ao-2", ProjectID: "ao", IssueID: "github:polymath-ventures/agent-orchestrator#2", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
			{ID: "ao-3", ProjectID: "ao", IssueID: "github:polymath-ventures/agent-orchestrator#3", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode, Metadata: domain.SessionMetadata{Model: "claude-opus-4-8"}},
			{ID: "ao-orch", ProjectID: "ao", Kind: domain.KindOrchestrator, Harness: domain.HarnessClaudeCode},
			{ID: "ao-old", ProjectID: "ao", Kind: domain.KindWorker, Harness: domain.HarnessCodex, IsTerminated: true},
		},
	}, workerCapacityHealth{snapshot: agenthealth.Snapshot{
		CheckedAt: now,
		Harnesses: []agenthealth.HarnessHealth{
			{ID: string(domain.HarnessCodex), Label: "Codex", Health: agenthealth.HealthHealthy, CheckedAt: now},
			{ID: string(domain.HarnessClaudeCode), Label: "Claude Code", Health: agenthealth.HealthUnauthorized, Reason: "not authenticated", Remedy: "run `claude`", CheckedAt: now},
		},
	}})

	got, err := svc.WorkerCapacity(context.Background(), "ao")
	if err != nil {
		t.Fatalf("WorkerCapacity: %v", err)
	}
	if got.State != "degraded" || got.Cap == nil || *got.Cap != 10 {
		t.Fatalf("summary = state %q cap %#v, want degraded cap 10", got.State, got.Cap)
	}
	if got.ActiveWorkers != 3 {
		t.Fatalf("ActiveWorkers = %d, want 3", got.ActiveWorkers)
	}
	if got.DownBucketShare == nil || *got.DownBucketShare != 3 {
		t.Fatalf("DownBucketShare = %#v, want 3", got.DownBucketShare)
	}
	if got.AvailableCapacity == nil || *got.AvailableCapacity != 7 {
		t.Fatalf("AvailableCapacity = %#v, want 7", got.AvailableCapacity)
	}
	if got.FreeAvailableCapacity == nil || *got.FreeAvailableCapacity != 4 {
		t.Fatalf("FreeAvailableCapacity = %#v, want 4", got.FreeAvailableCapacity)
	}
	if len(got.Buckets) != 2 {
		t.Fatalf("bucket count = %d, want 2", len(got.Buckets))
	}
	if got.Buckets[0].Agent != domain.HarnessCodex || got.Buckets[0].TargetPercent != 70 || got.Buckets[0].RealizedPercent != 66.7 {
		t.Fatalf("codex bucket = %#v", got.Buckets[0])
	}
	if got.Buckets[1].Agent != domain.HarnessClaudeCode || !got.Buckets[1].Down || got.Buckets[1].DownCapacityShare == nil || *got.Buckets[1].DownCapacityShare != 3 {
		t.Fatalf("claude bucket = %#v", got.Buckets[1])
	}
}

func TestWorkerCapacityUncappedFallbackWorker(t *testing.T) {
	svc := project.NewWorkerCapacity(workerCapacityStore{
		project: domain.ProjectRecord{
			ID: "ao",
			Config: domain.ProjectConfig{
				Worker: domain.RoleOverride{Harness: domain.HarnessCodex},
			},
		},
		sessions: []domain.SessionRecord{{ID: "ao-1", ProjectID: "ao", Kind: domain.KindWorker, Harness: domain.HarnessCodex}},
	}, workerCapacityHealth{snapshot: agenthealth.Snapshot{
		Harnesses: []agenthealth.HarnessHealth{{ID: string(domain.HarnessCodex), Label: "Codex", Health: agenthealth.HealthHealthy}},
	}})

	got, err := svc.WorkerCapacity(context.Background(), "ao")
	if err != nil {
		t.Fatalf("WorkerCapacity: %v", err)
	}
	if got.State != "uncapped" || got.Cap != nil || got.AvailableCapacity != nil {
		t.Fatalf("summary = state %q cap %#v usable %#v, want uncapped with nil capacity", got.State, got.Cap, got.AvailableCapacity)
	}
	if len(got.Buckets) != 1 || got.Buckets[0].TargetPercent != 100 || got.Buckets[0].ActiveWorkers != 1 {
		t.Fatalf("buckets = %#v", got.Buckets)
	}
}

func TestWorkerCapacityReportsMaxConcurrentWhenTrackerIntakeDisabled(t *testing.T) {
	svc := project.NewWorkerCapacity(workerCapacityStore{
		project: domain.ProjectRecord{
			ID: "ao",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: false, MaxConcurrent: 3},
				WorkerMix:     domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}},
			},
		},
		sessions: []domain.SessionRecord{{ID: "ao-1", ProjectID: "ao", IssueID: "github:polymath-ventures/agent-orchestrator#1", Kind: domain.KindWorker, Harness: domain.HarnessCodex}},
	}, workerCapacityHealth{snapshot: agenthealth.Snapshot{
		Harnesses: []agenthealth.HarnessHealth{{ID: string(domain.HarnessCodex), Label: "Codex", Health: agenthealth.HealthHealthy}},
	}})

	got, err := svc.WorkerCapacity(context.Background(), "ao")
	if err != nil {
		t.Fatalf("WorkerCapacity: %v", err)
	}
	if got.State != "healthy" || got.Cap == nil || *got.Cap != 3 {
		t.Fatalf("summary = state %q cap %#v, want healthy cap 3", got.State, got.Cap)
	}
	if got.AvailableCapacity == nil || *got.AvailableCapacity != 3 {
		t.Fatalf("AvailableCapacity = %#v, want 3", got.AvailableCapacity)
	}
	if got.FreeAvailableCapacity == nil || *got.FreeAvailableCapacity != 2 {
		t.Fatalf("FreeAvailableCapacity = %#v, want 2", got.FreeAvailableCapacity)
	}
}

func TestWorkerCapacityFreeCapacityCountsAllLiveWorkers(t *testing.T) {
	svc := project.NewWorkerCapacity(workerCapacityStore{
		project: domain.ProjectRecord{
			ID: "ao",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, MaxConcurrent: 3},
				WorkerMix:     domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}},
			},
		},
		sessions: []domain.SessionRecord{
			{ID: "intake", ProjectID: "ao", IssueID: "github:polymath-ventures/agent-orchestrator#1", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
			{ID: "manual", ProjectID: "ao", IssueID: "manual-1", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
			{ID: "ad-hoc", ProjectID: "ao", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
		},
	}, workerCapacityHealth{snapshot: agenthealth.Snapshot{
		Harnesses: []agenthealth.HarnessHealth{{ID: string(domain.HarnessCodex), Label: "Codex", Health: agenthealth.HealthHealthy}},
	}})

	got, err := svc.WorkerCapacity(context.Background(), "ao")
	if err != nil {
		t.Fatalf("WorkerCapacity: %v", err)
	}
	if got.ActiveWorkers != 3 {
		t.Fatalf("ActiveWorkers = %d, want 3", got.ActiveWorkers)
	}
	if got.FreeAvailableCapacity == nil || *got.FreeAvailableCapacity != 0 {
		t.Fatalf("FreeAvailableCapacity = %#v, want 0", got.FreeAvailableCapacity)
	}
}
