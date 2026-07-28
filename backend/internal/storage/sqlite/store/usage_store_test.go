package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestUsageBindingAndSourceIdempotency(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()

	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:        sess.ID,
		Harness:          sess.Harness,
		NativeRootID:     "root-thread",
		InitialModelID:   "gpt-5",
		SourceCLIVersion: "0.145.0",
		State:            domain.UsageBindingDiscovering,
		FirstSeenAt:      now,
		LastSeenAt:       now,
		UpdatedAt:        now,
	})
	if err != nil {
		t.Fatalf("upsert binding: %v", err)
	}
	again, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:        sess.ID,
		Harness:          sess.Harness,
		NativeRootID:     "root-thread",
		InitialModelID:   "gpt-5.1",
		SourceCLIVersion: "0.146.0",
		State:            domain.UsageBindingActive,
		FirstSeenAt:      now.Add(time.Hour),
		LastSeenAt:       now.Add(time.Hour),
		UpdatedAt:        now.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("upsert binding again: %v", err)
	}
	if again.ID != binding.ID || again.FirstSeenAt != binding.FirstSeenAt {
		t.Fatalf("idempotent binding = %+v, want same id/first_seen as %+v", again, binding)
	}
	if again.InitialModelID != "gpt-5.1" || again.SourceCLIVersion != "0.146.0" || again.State != domain.UsageBindingActive {
		t.Fatalf("refreshed binding = %+v", again)
	}

	src, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino",
		ParserVersion:   "codex-rollout/v1",
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatalf("insert source: %v", err)
	}
	srcAgain, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread-updated",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino:updated",
		ParserVersion:   "codex-rollout/v1",
		State:           domain.UsageSourcePending,
		CreatedAt:       now.Add(time.Hour),
		UpdatedAt:       now.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("insert source again: %v", err)
	}
	if srcAgain.ID != src.ID || srcAgain.NativeSessionID != "child-thread-updated" ||
		srcAgain.FileIdentity != "dev:ino" || srcAgain.ParserVersion != "codex-rollout/v1" {
		t.Fatalf("idempotent source = %+v", srcAgain)
	}

	watchable, err := s.ListWatchableUsageSources(ctx)
	if err != nil {
		t.Fatalf("watchable sources: %v", err)
	}
	if len(watchable) != 1 || watchable[0].ID != src.ID {
		t.Fatalf("watchable sources = %+v, want source %d", watchable, src.ID)
	}

	bindings, err := s.ListUsageBindingsForSession(ctx, sess.ID)
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	sources, err := s.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		t.Fatalf("sources: %v", err)
	}
	aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
	if err != nil {
		t.Fatalf("aggregates: %v", err)
	}
	if len(bindings) != 1 || len(sources) != 1 || len(aggregates) != 0 {
		t.Fatalf("rows = bindings:%d sources:%d aggregates:%d, want 1/1/0", len(bindings), len(sources), len(aggregates))
	}
}

func TestApplyUsageChunkAtomicReplayAndAggregates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	reasoning := int64(3)
	cost := int64(12345)
	event := usageEvent("event-1", "hash-1", now, domain.UsageTokenMetrics{
		InputTokens:         100,
		UncachedInputTokens: 40,
		CacheReadTokens:     50,
		CacheWriteTokens:    10,
		OutputTokens:        20,
		ReasoningTokens:     &reasoning,
	}, &cost)

	result, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
		ByteOffset:                100,
		State:                     domain.UsageSourceActive,
		BaselineInputTokens:       100,
		BaselineCachedInputTokens: 50,
		BaselineCacheWriteTokens:  10,
		BaselineOutputTokens:      20,
		BaselineReasoningTokens:   3,
		CurrentModelID:            "gpt-5.6",
		CurrentProvider:           "openai",
		LastObservedAt:            &now,
		UpdatedAt:                 now,
	}, []domain.ModelUsageEvent{event})
	if err != nil {
		t.Fatalf("apply chunk: %v", err)
	}
	if result.InsertedEvents != 1 || result.DuplicateEvents != 0 {
		t.Fatalf("result = %+v, want 1 insert", result)
	}

	result, err = s.ApplyUsageChunk(ctx, source.ID, 100, domain.SourceCursorState{
		ByteOffset:                120,
		State:                     domain.UsageSourceActive,
		BaselineInputTokens:       100,
		BaselineCachedInputTokens: 50,
		BaselineCacheWriteTokens:  10,
		BaselineOutputTokens:      20,
		BaselineReasoningTokens:   3,
		CurrentModelID:            "gpt-5.6",
		CurrentProvider:           "openai",
		LastObservedAt:            &now,
		UpdatedAt:                 now.Add(time.Second),
	}, []domain.ModelUsageEvent{event})
	if err != nil {
		t.Fatalf("apply duplicate chunk: %v", err)
	}
	if result.InsertedEvents != 0 || result.DuplicateEvents != 1 {
		t.Fatalf("duplicate result = %+v, want one duplicate", result)
	}

	aggs, err := s.ListUsageModelAggregates(ctx, sess.ID)
	if err != nil {
		t.Fatalf("aggregates: %v", err)
	}
	if len(aggs) != 1 {
		t.Fatalf("aggregates = %+v, want one row", aggs)
	}
	got := aggs[0]
	if got.Tokens.InputTokens != 100 || got.Tokens.OutputTokens != 20 || got.Tokens.ReasoningTokens == nil || *got.Tokens.ReasoningTokens != 3 {
		t.Fatalf("aggregate tokens = %+v", got.Tokens)
	}
	if got.EstimatedCostNanos != cost || got.EstimatedCostEventCount != 1 {
		t.Fatalf("aggregate cost = %+v", got)
	}
	if got.LastObservedAt == nil || !got.LastObservedAt.Equal(now) {
		t.Fatalf("aggregate last observed = %v, want %v", got.LastObservedAt, now)
	}

	if got.EventCount != 1 || got.ReasoningEventCount != 1 || got.EstimatedCostEventCount != 1 {
		t.Fatalf("aggregate coverage counts = %+v, want 1/1/1", got)
	}

	ctxRow, ok, err := s.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("get source context: ok=%v err=%v", ok, err)
	}
	if ctxRow.Source.ByteOffset != 120 || ctxRow.ProjectID != sess.ProjectID || ctxRow.NativeRootID != "root-thread" ||
		ctxRow.Source.CurrentModelID != "gpt-5.6" || ctxRow.Source.CurrentProvider != "openai" ||
		ctxRow.InitialModelID != "gpt-5" || ctxRow.BindingState != domain.UsageBindingActive {
		t.Fatalf("source context = %+v", ctxRow)
	}
}

func TestApplyUsageChunkRejectsConflictsAndPreservesCursor(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{ByteOffset: 50, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-1", "hash-1", now, domain.UsageTokenMetrics{InputTokens: 10, UncachedInputTokens: 10, OutputTokens: 1}, nil),
	}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	conflict := usageEvent("event-1", "different-hash", now, domain.UsageTokenMetrics{InputTokens: 11, UncachedInputTokens: 11, OutputTokens: 1}, nil)
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 50, domain.SourceCursorState{ByteOffset: 80, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{conflict}); !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("conflict err = %v, want ErrUsageSourceEventConflict", err)
	}
	assertUsageSourceOffset(t, s, source.ID, 50)

	bad := usageEvent("event-2", "hash-2", now, domain.UsageTokenMetrics{
		InputTokens:         10,
		UncachedInputTokens: 10,
		CacheReadTokens:     11,
		OutputTokens:        1,
	}, nil)
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 50, domain.SourceCursorState{ByteOffset: 90, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{bad}); err == nil {
		t.Fatal("expected invalid event insert to fail")
	}
	assertUsageSourceOffset(t, s, source.ID, 50)

	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{ByteOffset: 60, State: domain.UsageSourceActive, UpdatedAt: now}, nil); !errors.Is(err, domain.ErrUsageSourceOffsetConflict) {
		t.Fatalf("offset err = %v, want ErrUsageSourceOffsetConflict", err)
	}
	assertUsageSourceOffset(t, s, source.ID, 50)
}

func TestUsageRowsCascadeWhenSeedSessionDeleted(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "usage")
	now := time.Unix(1700000000, 0).UTC()
	sess, err := s.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("create seed session: %v", err)
	}
	source := seedUsageSource(t, s, sess, now)
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{ByteOffset: 10, State: domain.UsageSourceComplete, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-1", "hash-1", now, domain.UsageTokenMetrics{InputTokens: 1, UncachedInputTokens: 1, OutputTokens: 1}, nil),
	}); err != nil {
		t.Fatalf("apply event: %v", err)
	}

	deleted, err := s.DeleteSession(ctx, sess.ID)
	if err != nil || !deleted {
		t.Fatalf("delete seed session = %v, %v; want true nil", deleted, err)
	}
	bindings, err := s.ListUsageBindingsForSession(ctx, sess.ID)
	if err != nil {
		t.Fatalf("bindings after delete: %v", err)
	}
	aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
	if err != nil {
		t.Fatalf("aggregates after delete: %v", err)
	}
	if len(bindings) != 0 || len(aggregates) != 0 {
		t.Fatalf("rows after delete = bindings:%d aggregates:%d, want zero", len(bindings), len(aggregates))
	}
}

func TestListCompactSessionUsageAggregatesAndFiltersByProject(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	seedProject(t, s, "usage")
	seedProject(t, s, "other")

	usageRec := sampleRecord("usage")
	usageRec.Harness = domain.HarnessCodex
	usageSession, err := s.CreateSession(ctx, usageRec)
	if err != nil {
		t.Fatalf("create usage session: %v", err)
	}
	otherSession, err := s.CreateSession(ctx, sampleRecord("other"))
	if err != nil {
		t.Fatalf("create other session: %v", err)
	}
	source := seedUsageSource(t, s, usageSession, now)
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
		ByteOffset:     10,
		State:          domain.UsageSourceComplete,
		LastObservedAt: &now,
		UpdatedAt:      now,
	}, []domain.ModelUsageEvent{
		usageEvent("event-1", "hash-1", now, domain.UsageTokenMetrics{InputTokens: 100, UncachedInputTokens: 100, OutputTokens: 20}, nil),
		usageEvent("event-2", "hash-2", now.Add(time.Second), domain.UsageTokenMetrics{InputTokens: 50, UncachedInputTokens: 50, OutputTokens: 10}, nil),
	}); err != nil {
		t.Fatalf("apply usage events: %v", err)
	}
	if _, err := s.UpdateUsageBindingState(ctx, source.BindingID, domain.UsageBindingComplete, "", now); err != nil {
		t.Fatalf("complete binding: %v", err)
	}

	got, err := s.ListCompactSessionUsage(ctx, "usage")
	if err != nil {
		t.Fatalf("list compact usage: %v", err)
	}
	if len(got) != 1 || got[0].SessionID != usageSession.ID {
		t.Fatalf("filtered rows = %+v, want only %s (not %s)", got, usageSession.ID, otherSession.ID)
	}
	row := got[0]
	if row.TotalTokens != 180 || row.EventCount != 2 ||
		row.BindingCount != 1 || row.CompleteBindingCount != 1 ||
		row.SourceCount != 1 || row.CompleteSourceCount != 1 {
		t.Fatalf("aggregate = %+v", row)
	}
	if row.LastObservedAt == nil || !row.LastObservedAt.Equal(now.Add(time.Second)) {
		t.Fatalf("last observed = %v, want %v", row.LastObservedAt, now.Add(time.Second))
	}

	all, err := s.ListCompactSessionUsage(ctx, "")
	if err != nil {
		t.Fatalf("list all compact usage: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("all rows = %d, want 2", len(all))
	}
}

func seedUsageSession(t *testing.T, s *sqlite.Store, harness domain.AgentHarness) domain.SessionRecord {
	t.Helper()
	ctx := context.Background()
	seedProject(t, s, "usage")
	rec := sampleRecord("usage")
	rec.Harness = harness
	got, err := s.CreateSession(ctx, rec)
	if err != nil {
		t.Fatalf("create usage session: %v", err)
	}
	return got
}

func seedUsageSource(t *testing.T, s *sqlite.Store, sess domain.SessionRecord, now time.Time) domain.UsageSourceRecord {
	t.Helper()
	ctx := context.Background()
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:        sess.ID,
		Harness:          sess.Harness,
		NativeRootID:     "root-thread",
		InitialModelID:   "gpt-5",
		SourceCLIVersion: "0.145.0",
		State:            domain.UsageBindingActive,
		FirstSeenAt:      now,
		LastSeenAt:       now,
		UpdatedAt:        now,
	})
	if err != nil {
		t.Fatalf("upsert usage binding: %v", err)
	}
	source, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino",
		ParserVersion:   "codex-rollout/v1",
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatalf("insert usage source: %v", err)
	}
	return source
}

func usageEvent(key, hash string, at time.Time, tokens domain.UsageTokenMetrics, estimatedCost *int64) domain.ModelUsageEvent {
	return domain.ModelUsageEvent{
		Provider:        "openai",
		ModelID:         "gpt-5",
		ObservedAt:      at,
		Tokens:          tokens,
		Cost:            domain.UsageCostMetrics{EstimatedCostNanos: estimatedCost, CostBasis: domain.CostBasisAPIEstimate, Confidence: domain.CostConfidenceEstimate, PricingVersion: "test-pricing"},
		TokenConfidence: domain.TokenConfidenceParsed,
		SourceEventKey:  key,
		SourceUsageHash: hash,
		ParserVersion:   "codex-rollout/v1",
		CreatedAt:       at,
	}
}

func assertUsageSourceOffset(t *testing.T, s *sqlite.Store, sourceID int64, want int64) {
	t.Helper()
	got, ok, err := s.GetUsageSourceForIngestion(context.Background(), sourceID)
	if err != nil || !ok {
		t.Fatalf("get usage source: ok=%v err=%v", ok, err)
	}
	if got.Source.ByteOffset != want {
		t.Fatalf("source offset = %d, want %d", got.Source.ByteOffset, want)
	}
}
