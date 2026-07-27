package usage

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type compactUsageStoreStub struct {
	projectID domain.ProjectID
	rows      []domain.UsageSessionAggregate
	calls     int
}

func (s *compactUsageStoreStub) ListCompactSessionUsage(_ context.Context, projectID domain.ProjectID) ([]domain.UsageSessionAggregate, error) {
	s.projectID = projectID
	s.calls++
	return s.rows, nil
}

func TestSummaryReaderListCompactDerivesStatesAndCoverageInOneRead(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	store := &compactUsageStoreStub{rows: []domain.UsageSessionAggregate{
		{SessionID: "waiting", Harness: domain.HarnessCodex},
		{
			SessionID: "collecting", Harness: domain.HarnessClaudeCode,
			BindingCount: 1, SourceCount: 1, EventCount: 2, TotalTokens: 120,
			LastObservedAt: &now,
		},
		{
			SessionID: "complete", Harness: domain.HarnessCodex,
			BindingCount: 1, CompleteBindingCount: 1,
			SourceCount: 1, CompleteSourceCount: 1,
			EventCount: 3, TotalTokens: 240,
		},
		{
			SessionID: "partial", Harness: domain.HarnessCodex,
			BindingCount: 1, PartialBindingCount: 1,
			SourceCount: 1, ErrorSourceCount: 1,
			EventCount: 1, TotalTokens: 20,
		},
		{SessionID: "unsupported", Harness: domain.HarnessOpenCode, EventCount: 4, TotalTokens: 99},
	}}
	reader := NewSummaryReader(store)

	got, err := reader.ListCompact(context.Background(), "reverb")
	if err != nil {
		t.Fatalf("list compact: %v", err)
	}
	if store.calls != 1 || store.projectID != "reverb" {
		t.Fatalf("store calls/project = %d/%q, want 1/reverb", store.calls, store.projectID)
	}
	want := []struct {
		state    domain.UsageCollectionState
		coverage domain.UsageCoverage
		tokens   int64
	}{
		{domain.UsageCollectionWaiting, domain.UsageCoverageUnavailable, 0},
		{domain.UsageCollectionCollecting, domain.UsageCoveragePartial, 120},
		{domain.UsageCollectionComplete, domain.UsageCoverageComplete, 240},
		{domain.UsageCollectionPartial, domain.UsageCoveragePartial, 20},
		{domain.UsageCollectionUnavailable, domain.UsageCoverageUnavailable, 99},
	}
	if len(got) != len(want) {
		t.Fatalf("items = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].CollectionState != want[i].state || got[i].Coverage != want[i].coverage || got[i].TotalTokens != want[i].tokens {
			t.Errorf("item %d = %+v, want state=%s coverage=%s tokens=%d", i, got[i], want[i].state, want[i].coverage, want[i].tokens)
		}
	}
	if got[1].LastObservedAt == nil || !got[1].LastObservedAt.Equal(now) {
		t.Fatalf("last observed = %v, want %v", got[1].LastObservedAt, now)
	}
}
