package usage

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type compactUsageStore interface {
	ListCompactSessionUsage(context.Context, domain.ProjectID) ([]domain.UsageSessionAggregate, error)
}

// SummaryReader derives compact, token-only card data from one storage read.
type SummaryReader struct {
	store compactUsageStore
}

// NewSummaryReader constructs the compact usage read service.
func NewSummaryReader(store compactUsageStore) *SummaryReader {
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
		out = append(out, domain.CompactSessionUsage{
			SessionID:       row.SessionID,
			TotalTokens:     row.TotalTokens,
			CollectionState: state,
			Coverage:        tokenCoverage(row.EventCount, state),
			LastObservedAt:  row.LastObservedAt,
		})
	}
	return out, nil
}

func collectionState(row domain.UsageSessionAggregate) domain.UsageCollectionState {
	if !SupportedHarness(row.Harness) {
		return domain.UsageCollectionUnavailable
	}
	if row.PartialBindingCount > 0 || row.ErrorSourceCount > 0 || row.AnomalousSourceCount > 0 {
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

func tokenCoverage(eventCount int64, state domain.UsageCollectionState) domain.UsageCoverage {
	if eventCount == 0 || state == domain.UsageCollectionUnavailable {
		return domain.UsageCoverageUnavailable
	}
	if state == domain.UsageCollectionComplete {
		return domain.UsageCoverageComplete
	}
	return domain.UsageCoveragePartial
}
