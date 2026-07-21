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

// UpsertUsageBinding records or refreshes the association between an AO
// session and a native root session/thread.
func (s *Store) UpsertUsageBinding(ctx context.Context, rec domain.UsageBindingRecord) (domain.UsageBindingRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.UpsertUsageBinding(ctx, gen.UpsertUsageBindingParams{
		SessionID:        rec.SessionID,
		Harness:          rec.Harness,
		NativeRootID:     rec.NativeRootID,
		InitialModelID:   rec.InitialModelID,
		SourceCliVersion: rec.SourceCLIVersion,
		State:            usageBindingStateOrDefault(rec.State),
		LastErrorCode:    rec.LastErrorCode,
		FirstSeenAt:      timeOrNow(rec.FirstSeenAt),
		LastSeenAt:       timeOrNow(rec.LastSeenAt),
		UpdatedAt:        timeOrNow(rec.UpdatedAt),
	})
	if err != nil {
		return domain.UsageBindingRecord{}, fmt.Errorf("upsert usage binding for session %s root %q: %w", rec.SessionID, rec.NativeRootID, err)
	}
	return usageBindingFromGen(row), nil
}

// GetUsageBinding returns one binding, or ok=false when absent.
func (s *Store) GetUsageBinding(ctx context.Context, sessionID domain.SessionID, harness domain.AgentHarness, nativeRootID string) (domain.UsageBindingRecord, bool, error) {
	row, err := s.qr.GetUsageBindingBySessionHarnessRoot(ctx, gen.GetUsageBindingBySessionHarnessRootParams{
		SessionID:    sessionID,
		Harness:      harness,
		NativeRootID: nativeRootID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UsageBindingRecord{}, false, nil
	}
	if err != nil {
		return domain.UsageBindingRecord{}, false, fmt.Errorf("get usage binding for session %s root %q: %w", sessionID, nativeRootID, err)
	}
	return usageBindingFromGen(row), true, nil
}

// ListUsageBindingsForSession returns every native usage binding for a session.
func (s *Store) ListUsageBindingsForSession(ctx context.Context, sessionID domain.SessionID) ([]domain.UsageBindingRecord, error) {
	rows, err := s.qr.ListUsageBindingsForSession(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list usage bindings for session %s: %w", sessionID, err)
	}
	out := make([]domain.UsageBindingRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageBindingFromGen(row))
	}
	return out, nil
}

// UpdateUsageBindingState updates only the binding lifecycle/error state.
func (s *Store) UpdateUsageBindingState(ctx context.Context, id int64, state domain.UsageBindingState, lastErrorCode string, at time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateUsageBindingState(ctx, gen.UpdateUsageBindingStateParams{
		ID:            id,
		State:         usageBindingStateOrDefault(state),
		LastErrorCode: lastErrorCode,
		LastSeenAt:    timeOrNow(at),
		UpdatedAt:     timeOrNow(at),
	})
	if err != nil {
		return false, fmt.Errorf("update usage binding %d: %w", id, err)
	}
	return n > 0, nil
}

// InsertUsageSource records a physical JSONL source generation. Repeated calls
// for the same binding/path/generation return the existing row.
func (s *Store) InsertUsageSource(ctx context.Context, rec domain.UsageSourceRecord) (domain.UsageSourceRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.InsertUsageSource(ctx, usageSourceInsertParams(rec))
	if err != nil {
		return domain.UsageSourceRecord{}, fmt.Errorf("insert usage source for binding %d path %q generation %d: %w", rec.BindingID, rec.ArtifactPath, rec.Generation, err)
	}
	return usageSourceFromGen(row), nil
}

// ListObserverReadyUsageSources returns sources eligible for observer work.
func (s *Store) ListObserverReadyUsageSources(ctx context.Context, now time.Time, limit int64) ([]domain.UsageSourceRecord, error) {
	rows, err := s.qr.ListObserverReadyUsageSources(ctx, gen.ListObserverReadyUsageSourcesParams{
		NextRetryAt: sql.NullTime{Time: now.UTC(), Valid: true},
		Limit:       limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list observer-ready usage sources: %w", err)
	}
	out := make([]domain.UsageSourceRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageSourceFromGen(row))
	}
	return out, nil
}

// ListUnresolvedCodexUsageBindings returns pathless Codex bindings whose
// rollout files still need discovery.
func (s *Store) ListUnresolvedCodexUsageBindings(ctx context.Context, limit int64) ([]domain.UsageBindingRecord, error) {
	rows, err := s.qr.ListUnresolvedCodexBindings(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("list unresolved codex usage bindings: %w", err)
	}
	out := make([]domain.UsageBindingRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageBindingFromGen(row))
	}
	return out, nil
}

// GetUsageSourceForIngestion returns a source plus immutable binding/session
// facts needed by the observer and ingester.
func (s *Store) GetUsageSourceForIngestion(ctx context.Context, id int64) (domain.UsageSourceContext, bool, error) {
	row, err := s.qr.GetUsageSourceWithBindingAndSession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UsageSourceContext{}, false, nil
	}
	if err != nil {
		return domain.UsageSourceContext{}, false, fmt.Errorf("get usage source %d: %w", id, err)
	}
	return usageSourceContextFromGen(row), true, nil
}

// MarkUsageSourceState updates only the source lifecycle/error state.
func (s *Store) MarkUsageSourceState(ctx context.Context, id int64, state domain.UsageSourceState, lastErrorCode string, nextRetryAt *time.Time, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.MarkUsageSourceState(ctx, gen.MarkUsageSourceStateParams{
		ID:            id,
		State:         usageSourceStateOrDefault(state),
		LastErrorCode: lastErrorCode,
		NextRetryAt:   ptrTimeToNullTime(nextRetryAt),
		UpdatedAt:     timeOrNow(updatedAt),
	})
	if err != nil {
		return false, fmt.Errorf("mark usage source %d: %w", id, err)
	}
	return n > 0, nil
}

// ApplyUsageChunk atomically writes parsed usage events and advances the source
// cursor/baselines. The cursor never moves unless all event writes commit.
func (s *Store) ApplyUsageChunk(ctx context.Context, sourceID int64, expectedOffset int64, nextState domain.SourceCursorState, events []domain.ModelUsageEvent) (domain.ApplyUsageChunkResult, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var result domain.ApplyUsageChunkResult
	err := s.inTx(ctx, "apply usage chunk", func(q *gen.Queries) error {
		source, err := q.GetUsageSourceWithBindingAndSession(ctx, sourceID)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("usage source %d not found", sourceID)
		}
		if err != nil {
			return err
		}
		if source.ByteOffset != expectedOffset {
			return fmt.Errorf("%w: source %d has offset %d, expected %d", domain.ErrUsageSourceOffsetConflict, sourceID, source.ByteOffset, expectedOffset)
		}
		for _, ev := range events {
			existing, err := q.GetModelUsageEventByKey(ctx, gen.GetModelUsageEventByKeyParams{
				BindingID:      source.BindingID,
				SourceEventKey: ev.SourceEventKey,
			})
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				if existing.SourceUsageHash != ev.SourceUsageHash {
					return fmt.Errorf("%w: binding %d event %q", domain.ErrUsageSourceEventConflict, source.BindingID, ev.SourceEventKey)
				}
				result.DuplicateEvents++
				continue
			}
			if err := q.InsertModelUsageEvent(ctx, usageEventInsertParams(source, ev)); err != nil {
				return err
			}
			result.InsertedEvents++
		}
		return q.UpdateUsageSourceCursor(ctx, gen.UpdateUsageSourceCursorParams{
			ID:                        sourceID,
			ByteOffset:                nextState.ByteOffset,
			BaselineInputTokens:       nextState.BaselineInputTokens,
			BaselineCachedInputTokens: nextState.BaselineCachedInputTokens,
			BaselineCacheWriteTokens:  nextState.BaselineCacheWriteTokens,
			BaselineOutputTokens:      nextState.BaselineOutputTokens,
			BaselineReasoningTokens:   nextState.BaselineReasoningTokens,
			State:                     usageSourceStateOrDefault(nextState.State),
			FailureCount:              nextState.FailureCount,
			AnomalyCount:              nextState.AnomalyCount,
			NextRetryAt:               ptrTimeToNullTime(nextState.NextRetryAt),
			LastErrorCode:             nextState.LastErrorCode,
			LastObservedAt:            ptrTimeToNullTime(nextState.LastObservedAt),
			UpdatedAt:                 timeOrNow(nextState.UpdatedAt),
		})
	})
	return result, err
}

// ListUsageModelAggregates returns model-level aggregate rows for a session.
func (s *Store) ListUsageModelAggregates(ctx context.Context, sessionID domain.SessionID) ([]domain.UsageModelAggregate, error) {
	rows, err := s.qr.AggregateUsageBySessionHarnessModel(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("aggregate usage for session %s: %w", sessionID, err)
	}
	out := make([]domain.UsageModelAggregate, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageAggregateFromGen(row))
	}
	return out, nil
}

// UsageCoverageCountsForSession returns counts used to derive aggregate
// reasoning/cost coverage.
func (s *Store) UsageCoverageCountsForSession(ctx context.Context, sessionID domain.SessionID) (domain.UsageCoverageCounts, error) {
	row, err := s.qr.UsageCoverageCountsForSession(ctx, sessionID)
	if err != nil {
		return domain.UsageCoverageCounts{}, fmt.Errorf("usage coverage counts for session %s: %w", sessionID, err)
	}
	return domain.UsageCoverageCounts{
		EventCount:              row.EventCount,
		ReasoningEventCount:     row.ReasoningEventCount,
		EstimatedCostEventCount: row.EstimatedCostEventCount,
	}, nil
}

// CountUsageRowsForSession returns cheap row counts for summary state
// derivation and tests.
func (s *Store) CountUsageRowsForSession(ctx context.Context, sessionID domain.SessionID) (domain.UsageRowCounts, error) {
	row, err := s.qr.CountUsageRowsForSession(ctx, sessionID)
	if err != nil {
		return domain.UsageRowCounts{}, fmt.Errorf("count usage rows for session %s: %w", sessionID, err)
	}
	return domain.UsageRowCounts{BindingCount: row.BindingCount, SourceCount: row.SourceCount, EventCount: row.EventCount}, nil
}

func usageBindingFromGen(row gen.UsageBinding) domain.UsageBindingRecord {
	return domain.UsageBindingRecord{
		ID:               row.ID,
		SessionID:        row.SessionID,
		Harness:          row.Harness,
		NativeRootID:     row.NativeRootID,
		InitialModelID:   row.InitialModelID,
		SourceCLIVersion: row.SourceCliVersion,
		State:            row.State,
		LastErrorCode:    row.LastErrorCode,
		FirstSeenAt:      row.FirstSeenAt,
		LastSeenAt:       row.LastSeenAt,
		UpdatedAt:        row.UpdatedAt,
	}
}

func usageSourceFromGen(row gen.UsageSource) domain.UsageSourceRecord {
	return domain.UsageSourceRecord{
		ID:                        row.ID,
		BindingID:                 row.BindingID,
		Kind:                      row.Kind,
		NativeSessionID:           row.NativeSessionID,
		SubagentID:                row.SubagentID,
		ArtifactPath:              row.ArtifactPath,
		FileIdentity:              row.FileIdentity,
		Generation:                row.Generation,
		ByteOffset:                row.ByteOffset,
		BaselineInputTokens:       row.BaselineInputTokens,
		BaselineCachedInputTokens: row.BaselineCachedInputTokens,
		BaselineCacheWriteTokens:  row.BaselineCacheWriteTokens,
		BaselineOutputTokens:      row.BaselineOutputTokens,
		BaselineReasoningTokens:   row.BaselineReasoningTokens,
		ParserVersion:             row.ParserVersion,
		State:                     row.State,
		FailureCount:              row.FailureCount,
		AnomalyCount:              row.AnomalyCount,
		NextRetryAt:               nullTimePtr(row.NextRetryAt),
		LastErrorCode:             row.LastErrorCode,
		LastObservedAt:            nullTimePtr(row.LastObservedAt),
		CreatedAt:                 row.CreatedAt,
		UpdatedAt:                 row.UpdatedAt,
	}
}

func usageSourceContextFromGen(row gen.GetUsageSourceWithBindingAndSessionRow) domain.UsageSourceContext {
	return domain.UsageSourceContext{
		Source: domain.UsageSourceRecord{
			ID:                        row.SourceID,
			BindingID:                 row.BindingID,
			Kind:                      row.Kind,
			NativeSessionID:           row.NativeSessionID,
			SubagentID:                row.SubagentID,
			ArtifactPath:              row.ArtifactPath,
			FileIdentity:              row.FileIdentity,
			Generation:                row.Generation,
			ByteOffset:                row.ByteOffset,
			BaselineInputTokens:       row.BaselineInputTokens,
			BaselineCachedInputTokens: row.BaselineCachedInputTokens,
			BaselineCacheWriteTokens:  row.BaselineCacheWriteTokens,
			BaselineOutputTokens:      row.BaselineOutputTokens,
			BaselineReasoningTokens:   row.BaselineReasoningTokens,
			ParserVersion:             row.ParserVersion,
			State:                     row.SourceState,
			FailureCount:              row.FailureCount,
			AnomalyCount:              row.AnomalyCount,
			NextRetryAt:               nullTimePtr(row.NextRetryAt),
			LastErrorCode:             row.SourceLastErrorCode,
			LastObservedAt:            nullTimePtr(row.LastObservedAt),
			CreatedAt:                 row.SourceCreatedAt,
			UpdatedAt:                 row.SourceUpdatedAt,
		},
		SessionID:        row.SessionID,
		ProjectID:        row.ProjectID,
		Harness:          row.Harness,
		NativeRootID:     row.NativeRootID,
		SourceCLIVersion: row.SourceCliVersion,
	}
}

func usageSourceInsertParams(rec domain.UsageSourceRecord) gen.InsertUsageSourceParams {
	return gen.InsertUsageSourceParams{
		BindingID:                 rec.BindingID,
		Kind:                      rec.Kind,
		NativeSessionID:           rec.NativeSessionID,
		SubagentID:                rec.SubagentID,
		ArtifactPath:              rec.ArtifactPath,
		FileIdentity:              rec.FileIdentity,
		Generation:                rec.Generation,
		ByteOffset:                rec.ByteOffset,
		BaselineInputTokens:       rec.BaselineInputTokens,
		BaselineCachedInputTokens: rec.BaselineCachedInputTokens,
		BaselineCacheWriteTokens:  rec.BaselineCacheWriteTokens,
		BaselineOutputTokens:      rec.BaselineOutputTokens,
		BaselineReasoningTokens:   rec.BaselineReasoningTokens,
		ParserVersion:             rec.ParserVersion,
		State:                     usageSourceStateOrDefault(rec.State),
		FailureCount:              rec.FailureCount,
		AnomalyCount:              rec.AnomalyCount,
		NextRetryAt:               ptrTimeToNullTime(rec.NextRetryAt),
		LastErrorCode:             rec.LastErrorCode,
		LastObservedAt:            ptrTimeToNullTime(rec.LastObservedAt),
		CreatedAt:                 timeOrNow(rec.CreatedAt),
		UpdatedAt:                 timeOrNow(rec.UpdatedAt),
	}
}

func usageEventInsertParams(source gen.GetUsageSourceWithBindingAndSessionRow, ev domain.ModelUsageEvent) gen.InsertModelUsageEventParams {
	return gen.InsertModelUsageEventParams{
		BindingID:           source.BindingID,
		UsageSourceID:       source.SourceID,
		ProjectID:           source.ProjectID,
		SessionID:           source.SessionID,
		Harness:             source.Harness,
		Provider:            ev.Provider,
		ModelID:             ev.ModelID,
		ObservedAt:          ev.ObservedAt,
		InputTokens:         ev.Tokens.InputTokens,
		UncachedInputTokens: ev.Tokens.UncachedInputTokens,
		CacheReadTokens:     ev.Tokens.CacheReadTokens,
		CacheWriteTokens:    ev.Tokens.CacheWriteTokens,
		CacheWrite5mTokens:  ptrInt64ToNull(ev.Tokens.CacheWrite5mTokens),
		CacheWrite1hTokens:  ptrInt64ToNull(ev.Tokens.CacheWrite1hTokens),
		OutputTokens:        ev.Tokens.OutputTokens,
		ReasoningTokens:     ptrInt64ToNull(ev.Tokens.ReasoningTokens),
		DurationMs:          ptrInt64ToNull(ev.DurationMS),
		ReportedCostNanos:   ptrInt64ToNull(ev.Cost.ReportedCostNanos),
		EstimatedCostNanos:  ptrInt64ToNull(ev.Cost.EstimatedCostNanos),
		PricingVersion:      ev.Cost.PricingVersion,
		CostBasis:           costBasisOrDefault(ev.Cost.CostBasis),
		TokenConfidence:     tokenConfidenceOrDefault(ev.TokenConfidence),
		CostConfidence:      costConfidenceOrDefault(ev.Cost.Confidence),
		SourceEventKey:      ev.SourceEventKey,
		SourceUsageHash:     ev.SourceUsageHash,
		ParserVersion:       stringOrDefault(ev.ParserVersion, source.ParserVersion),
		SourceCliVersion:    stringOrDefault(ev.SourceCLIVersion, source.SourceCliVersion),
		CreatedAt:           timeOrNow(ev.CreatedAt),
	}
}

func usageAggregateFromGen(row gen.AggregateUsageBySessionHarnessModelRow) domain.UsageModelAggregate {
	var last *time.Time
	if t, ok := timeFromSQLiteValue(row.LastObservedAt); ok {
		last = &t
	}
	return domain.UsageModelAggregate{
		Harness:  row.Harness,
		Provider: row.Provider,
		ModelID:  row.ModelID,
		Tokens: domain.UsageTokenMetrics{
			InputTokens:         row.InputTokens,
			UncachedInputTokens: row.UncachedInputTokens,
			CacheReadTokens:     row.CacheReadTokens,
			CacheWriteTokens:    row.CacheWriteTokens,
			OutputTokens:        row.OutputTokens,
			ReasoningTokens:     int64PtrWhen(row.ReasoningTokens, row.ReasoningEventCount > 0),
		},
		EventCount:              row.EventCount,
		ReasoningEventCount:     row.ReasoningEventCount,
		EstimatedCostEventCount: row.EstimatedCostEventCount,
		EstimatedCostNanos:      row.EstimatedCostNanos,
		LastObservedAt:          last,
	}
}

func usageBindingStateOrDefault(state domain.UsageBindingState) domain.UsageBindingState {
	if state == "" {
		return domain.UsageBindingDiscovering
	}
	return state
}

func usageSourceStateOrDefault(state domain.UsageSourceState) domain.UsageSourceState {
	if state == "" {
		return domain.UsageSourcePending
	}
	return state
}

func tokenConfidenceOrDefault(v domain.TokenConfidence) domain.TokenConfidence {
	if v == "" {
		return domain.TokenConfidenceNone
	}
	return v
}

func costConfidenceOrDefault(v domain.CostConfidence) domain.CostConfidence {
	if v == "" {
		return domain.CostConfidenceNone
	}
	return v
}

func costBasisOrDefault(v domain.CostBasis) domain.CostBasis {
	if v == "" {
		return domain.CostBasisUnavailable
	}
	return v
}

func stringOrDefault(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

func timeOrNow(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t.UTC()
}

func ptrTimeToNullTime(t *time.Time) sql.NullTime {
	if t == nil || t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t.UTC(), Valid: true}
}

func nullTimePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	out := t.Time
	return &out
}

func ptrInt64ToNull(v *int64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *v, Valid: true}
}

func int64PtrWhen(v int64, ok bool) *int64 {
	if !ok {
		return nil
	}
	return &v
}

func timeFromSQLiteValue(v any) (time.Time, bool) {
	switch x := v.(type) {
	case time.Time:
		return x, true
	case string:
		return parseSQLiteTimeString(x)
	case []byte:
		return parseSQLiteTimeString(string(x))
	}
	return time.Time{}, false
}

func parseSQLiteTimeString(s string) (time.Time, bool) {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
