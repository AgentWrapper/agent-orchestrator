package usage

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type compactUsageStoreStub struct {
	projectID       domain.ProjectID
	rows            []domain.UsageSessionAggregate
	compactCalls    int
	getSessionCalls int
	bindingCalls    int
	sourceCalls     int
	modelCalls      int
	session         domain.SessionRecord
	found           bool
	bindings        []domain.UsageBindingRecord
	sources         []domain.UsageSourceRecord
	models          []domain.UsageModelAggregate
}

func (s *compactUsageStoreStub) ListCompactSessionUsage(_ context.Context, projectID domain.ProjectID) ([]domain.UsageSessionAggregate, error) {
	s.projectID = projectID
	s.compactCalls++
	return s.rows, nil
}

func (s *compactUsageStoreStub) GetSession(
	_ context.Context,
	_ domain.SessionID,
) (domain.SessionRecord, bool, error) {
	s.getSessionCalls++
	return s.session, s.found, nil
}

func (s *compactUsageStoreStub) ListUsageBindingsForSession(
	_ context.Context,
	_ domain.SessionID,
) ([]domain.UsageBindingRecord, error) {
	s.bindingCalls++
	return s.bindings, nil
}

func (s *compactUsageStoreStub) ListUsageSourcesForSession(
	_ context.Context,
	_ domain.SessionID,
) ([]domain.UsageSourceRecord, error) {
	s.sourceCalls++
	return s.sources, nil
}

func (s *compactUsageStoreStub) ListUsageModelAggregates(
	_ context.Context,
	_ domain.SessionID,
) ([]domain.UsageModelAggregate, error) {
	s.modelCalls++
	return s.models, nil
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
	if store.compactCalls != 1 || store.projectID != "reverb" {
		t.Fatalf("store calls/project = %d/%q, want 1/reverb", store.compactCalls, store.projectID)
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

func TestSummaryReaderGetReturnsDetailedTokenTelemetry(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	reasoning := int64(40)
	store := &compactUsageStoreStub{
		found:   true,
		session: domain.SessionRecord{ID: "reverb-12", Harness: domain.HarnessCodex},
		bindings: []domain.UsageBindingRecord{
			{ID: 1, State: domain.UsageBindingActive},
			{ID: 2, State: domain.UsageBindingComplete},
		},
		sources: []domain.UsageSourceRecord{
			{ID: 10, BindingID: 1, State: domain.UsageSourceActive},
			{ID: 11, BindingID: 1, SubagentID: "child-1", State: domain.UsageSourceComplete},
			{ID: 12, BindingID: 2, State: domain.UsageSourceComplete},
		},
		models: []domain.UsageModelAggregate{{
			Harness:             domain.HarnessCodex,
			Provider:            "openai",
			ModelID:             "gpt-5.6",
			Tokens:              domain.UsageTokenMetrics{InputTokens: 1000, UncachedInputTokens: 600, CacheReadTokens: 400, OutputTokens: 200, ReasoningTokens: &reasoning},
			EventCount:          2,
			ReasoningEventCount: 2,
			LastObservedAt:      &now,
		}},
	}

	got, err := NewSummaryReader(store).Get(context.Background(), "reverb-12")
	if err != nil {
		t.Fatalf("get detailed usage: %v", err)
	}
	if got.Collection.State != domain.UsageCollectionCollecting ||
		got.Collection.LastObservedAt == nil ||
		!got.Collection.LastObservedAt.Equal(now) {
		t.Fatalf("collection = %+v", got.Collection)
	}
	if got.Totals.InputTokens.Value == nil || *got.Totals.InputTokens.Value != 1000 ||
		got.Totals.OutputTokens.Value == nil || *got.Totals.OutputTokens.Value != 200 ||
		got.Totals.CacheReadTokens.Value == nil || *got.Totals.CacheReadTokens.Value != 400 ||
		got.Totals.ReasoningTokens.Value == nil || *got.Totals.ReasoningTokens.Value != 40 {
		t.Fatalf("totals = %+v", got.Totals)
	}
	if got.Totals.InputTokens.Coverage != domain.UsageCoveragePartial ||
		got.Totals.OutputTokens.Coverage != domain.UsageCoveragePartial {
		t.Fatalf("coverage = %+v", got.Totals)
	}
	if len(got.Harnesses) != 1 || len(got.Harnesses[0].Models) != 1 ||
		got.Harnesses[0].Models[0].ModelID != "gpt-5.6" {
		t.Fatalf("harnesses = %+v", got.Harnesses)
	}
	if store.getSessionCalls != 1 || store.bindingCalls != 1 || store.sourceCalls != 1 || store.modelCalls != 1 {
		t.Fatalf(
			"detailed read calls = session:%d bindings:%d sources:%d models:%d, want 1 each",
			store.getSessionCalls,
			store.bindingCalls,
			store.sourceCalls,
			store.modelCalls,
		)
	}
}
