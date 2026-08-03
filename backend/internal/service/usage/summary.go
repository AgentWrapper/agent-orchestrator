package usage

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type usageSummaryStore interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListCompactSessionUsage(context.Context, domain.ProjectID) ([]domain.UsageSessionAggregate, error)
	ListUsageBindingsForSession(context.Context, domain.SessionID) ([]domain.UsageBindingRecord, error)
	ListUsageSourcesForSession(context.Context, domain.SessionID) ([]domain.UsageSourceRecord, error)
	ListUsageModelAggregates(context.Context, domain.SessionID) ([]domain.UsageModelAggregate, error)
}

// SummaryReader derives compact, token-only card data from one storage read.
type SummaryReader struct {
	store usageSummaryStore
}

// NewSummaryReader constructs the compact usage read service.
func NewSummaryReader(store usageSummaryStore) *SummaryReader {
	return &SummaryReader{store: store}
}

// ListCompact returns usage summaries for all sessions, optionally filtered to
// one project. It deliberately performs no per-session follow-up reads.
func (r *SummaryReader) ListCompact(ctx context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsage, error) {
	if r == nil || r.store == nil {
		return nil, fmt.Errorf("usage summary store is unavailable")
	}
	rows, err := r.store.ListCompactSessionUsage(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.CompactSessionUsage, 0, len(rows))
	for _, row := range rows {
		state := collectionState(row)
		incomplete := usageIsIncomplete(row)
		out = append(out, domain.CompactSessionUsage{
			SessionID:       row.SessionID,
			TotalTokens:     row.TotalTokens,
			CollectionState: state,
			Coverage:        tokenCoverage(row.EventCount, state, incomplete),
		})
	}
	return out, nil
}

// Get returns detailed token telemetry for one session.
func (r *SummaryReader) Get(ctx context.Context, sessionID domain.SessionID) (domain.SessionUsageSummary, error) {
	if r == nil || r.store == nil {
		return domain.SessionUsageSummary{}, fmt.Errorf("usage summary store is unavailable")
	}
	session, ok, err := r.store.GetSession(ctx, sessionID)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	if !ok {
		return domain.SessionUsageSummary{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	bindings, err := r.store.ListUsageBindingsForSession(ctx, sessionID)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	aggregate := domain.UsageSessionAggregate{SessionID: sessionID, Harness: session.Harness}
	warnings := make(map[string]struct{})
	for _, binding := range bindings {
		aggregate.BindingCount++
		if binding.State == domain.UsageBindingComplete {
			aggregate.CompleteBindingCount++
		}
		if binding.State == domain.UsageBindingPartial || isUsageIntegrityWarning(binding.LastErrorCode) {
			aggregate.PartialBindingCount++
		}
		addUsageWarning(warnings, binding.LastErrorCode)
	}
	sources, err := r.store.ListUsageSourcesForSession(ctx, sessionID)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	for _, source := range sources {
		if source.LastErrorCode == domain.UsageErrorArtifactReplaced {
			continue
		}
		aggregate.SourceCount++
		if source.State == domain.UsageSourceComplete {
			aggregate.CompleteSourceCount++
		}
		if source.State == domain.UsageSourceError {
			aggregate.ErrorSourceCount++
		}
		if source.AnomalyCount > 0 || isUsageIntegrityWarning(source.LastErrorCode) {
			aggregate.AnomalousSourceCount++
		}
		addUsageWarning(warnings, source.LastErrorCode)
	}
	models, err := r.store.ListUsageModelAggregates(ctx, sessionID)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	var lastObservedAt *time.Time
	for _, model := range models {
		aggregate.EventCount += model.EventCount
		if model.LastObservedAt != nil &&
			(lastObservedAt == nil || model.LastObservedAt.After(*lastObservedAt)) {
			observedAt := *model.LastObservedAt
			lastObservedAt = &observedAt
		}
	}
	state := collectionState(aggregate)
	incomplete := usageIsIncomplete(aggregate)
	return domain.SessionUsageSummary{
		SessionID: sessionID,
		Collection: domain.UsageCollectionSummary{
			State:          state,
			LastObservedAt: lastObservedAt,
			Warnings:       sortedUsageWarnings(warnings),
		},
		Totals:    usageTotals(models, state, incomplete),
		Harnesses: harnessUsageSummaries(models, state, incomplete),
	}, nil
}

func collectionState(row domain.UsageSessionAggregate) domain.UsageCollectionState {
	if !SupportedHarness(row.Harness) {
		return domain.UsageCollectionUnavailable
	}
	if row.PartialBindingCount > 0 {
		return domain.UsageCollectionPartial
	}
	if row.BindingCount == 0 || row.SourceCount == 0 {
		return domain.UsageCollectionWaiting
	}
	if row.CompleteBindingCount == row.BindingCount && row.CompleteSourceCount == row.SourceCount {
		return domain.UsageCollectionComplete
	}
	return domain.UsageCollectionCollecting
}

func tokenCoverage(
	eventCount int64,
	state domain.UsageCollectionState,
	incomplete bool,
) domain.UsageCoverage {
	if eventCount == 0 || state == domain.UsageCollectionUnavailable {
		return domain.UsageCoverageUnavailable
	}
	if incomplete {
		return domain.UsageCoveragePartial
	}
	return domain.UsageCoverageComplete
}

func usageTotals(
	models []domain.UsageModelAggregate,
	state domain.UsageCollectionState,
	incomplete bool,
) domain.UsageMetricTotals {
	var input, uncached, cacheRead, cacheWrite, output, reasoning int64
	var events, reasoningEvents int64
	for _, model := range models {
		input += model.Tokens.InputTokens
		uncached += model.Tokens.UncachedInputTokens
		cacheRead += model.Tokens.CacheReadTokens
		cacheWrite += model.Tokens.CacheWriteTokens
		output += model.Tokens.OutputTokens
		if model.Tokens.ReasoningTokens != nil {
			reasoning += *model.Tokens.ReasoningTokens
		}
		events += model.EventCount
		reasoningEvents += model.ReasoningEventCount
	}
	tokenMetric := func(value int64) domain.UsageMetricCoverage {
		if events == 0 {
			return domain.UsageMetricCoverage{Coverage: domain.UsageCoverageUnavailable}
		}
		return domain.UsageMetricCoverage{
			Value: int64Pointer(value), Coverage: tokenCoverage(events, state, incomplete),
		}
	}
	reasoningMetric := domain.UsageMetricCoverage{Coverage: domain.UsageCoverageUnavailable}
	if reasoningEvents > 0 {
		coverage := tokenCoverage(events, state, incomplete)
		if reasoningEvents < events {
			coverage = domain.UsageCoveragePartial
		}
		reasoningMetric = domain.UsageMetricCoverage{Value: int64Pointer(reasoning), Coverage: coverage}
	}
	return domain.UsageMetricTotals{
		InputTokens:         tokenMetric(input),
		UncachedInputTokens: tokenMetric(uncached),
		CacheReadTokens:     tokenMetric(cacheRead),
		CacheWriteTokens:    tokenMetric(cacheWrite),
		OutputTokens:        tokenMetric(output),
		ReasoningTokens:     reasoningMetric,
	}
}

func harnessUsageSummaries(
	models []domain.UsageModelAggregate,
	state domain.UsageCollectionState,
	incomplete bool,
) []domain.HarnessUsageSummary {
	type harnessKey struct {
		harness  domain.AgentHarness
		provider string
	}
	order := make([]harnessKey, 0)
	grouped := make(map[harnessKey][]domain.UsageModelAggregate)
	for _, model := range models {
		key := harnessKey{harness: model.Harness, provider: model.Provider}
		if _, ok := grouped[key]; !ok {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], model)
	}
	out := make([]domain.HarnessUsageSummary, 0, len(order))
	for _, key := range order {
		rows := grouped[key]
		summary := domain.HarnessUsageSummary{
			Harness:  key.harness,
			Provider: key.provider,
			Totals:   usageTotals(rows, state, incomplete),
			Models:   make([]domain.ModelUsageSummary, 0, len(rows)),
		}
		for _, row := range rows {
			summary.Models = append(summary.Models, domain.ModelUsageSummary{
				ModelID:  row.ModelID,
				Provider: row.Provider,
				Totals:   usageTotals([]domain.UsageModelAggregate{row}, state, incomplete),
			})
		}
		out = append(out, summary)
	}
	return out
}

func usageIsIncomplete(row domain.UsageSessionAggregate) bool {
	return row.PartialBindingCount > 0 || row.AnomalousSourceCount > 0
}

func addUsageWarning(warnings map[string]struct{}, warning string) {
	if isUsageIntegrityWarning(warning) {
		warnings[warning] = struct{}{}
	}
}

func isUsageIntegrityWarning(warning string) bool {
	switch warning {
	case domain.UsageErrorArtifactPathRejected,
		domain.UsageErrorRecordTooLarge,
		domain.UsageErrorMalformedJSONL,
		domain.UsageErrorUnsupportedSourceFormat,
		domain.UsageErrorSourceEventConflict,
		domain.UsageErrorNonMonotonicCumulativeUsage,
		domain.UsageErrorInvalidParserState,
		domain.UsageErrorUnresolvedSpawnCall,
		domain.UsageErrorCodexSourceBudgetExceeded:
		return true
	default:
		return false
	}
}

func sortedUsageWarnings(warnings map[string]struct{}) []string {
	out := make([]string, 0, len(warnings))
	for warning := range warnings {
		out = append(out, warning)
	}
	sort.Strings(out)
	return out
}

func int64Pointer(value int64) *int64 {
	return &value
}
