package store_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
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
		SessionID:      sess.ID,
		Harness:        sess.Harness,
		NativeRootID:   "root-thread",
		InitialModelID: "gpt-5",
		State:          domain.UsageBindingDiscovering,
		FirstSeenAt:    now,
		LastSeenAt:     now,
		UpdatedAt:      now,
	})
	if err != nil {
		t.Fatalf("upsert binding: %v", err)
	}
	again, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:      sess.ID,
		Harness:        sess.Harness,
		NativeRootID:   "root-thread",
		InitialModelID: "gpt-5.1",
		State:          domain.UsageBindingActive,
		FirstSeenAt:    now.Add(time.Hour),
		LastSeenAt:     now.Add(time.Hour),
		UpdatedAt:      now.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("upsert binding again: %v", err)
	}
	if again.ID != binding.ID || again.FirstSeenAt != binding.FirstSeenAt {
		t.Fatalf("idempotent binding = %+v, want same id/first_seen as %+v", again, binding)
	}
	if again.InitialModelID != "gpt-5.1" || again.State != domain.UsageBindingActive {
		t.Fatalf("refreshed binding = %+v", again)
	}

	src, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino",
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
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{}}`,
		State:           domain.UsageSourcePending,
		CreatedAt:       now.Add(time.Hour),
		UpdatedAt:       now.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("insert source again: %v", err)
	}
	if srcAgain.ID != src.ID || srcAgain.NativeSessionID != "child-thread-updated" ||
		srcAgain.FileIdentity != "dev:ino" || srcAgain.ParserStateJSON != "{}" {
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

func TestUsageBindingUpsertDoesNotRegressSettledLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:     sess.ID,
		Harness:       sess.Harness,
		NativeRootID:  "root-thread",
		State:         domain.UsageBindingFinalizing,
		LastErrorCode: "finalizing-warning",
		FirstSeenAt:   now,
		LastSeenAt:    now,
		UpdatedAt:     now,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now.Add(time.Second),
		UpdatedAt:    now.Add(time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != binding.ID || got.State != domain.UsageBindingFinalizing || got.LastErrorCode != "finalizing-warning" {
		t.Fatalf("stale upsert regressed binding: %+v", got)
	}
}

func TestFinalizeUsageBindingsForSessionLaunchIsGenerationAndRevisionFenced(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	sess.Metadata.RuntimeLaunchID = "launch-current"
	if err := s.UpdateSession(ctx, sess); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0).UTC()
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedRevision := sess.UpdatedAt

	finalized, err := s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-stale",
		expectedRevision,
		now.Add(time.Second),
	)
	if err != nil || len(finalized) != 0 {
		t.Fatalf("stale finalization rows=%+v err=%v", finalized, err)
	}
	got, ok, err := s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingActive {
		t.Fatalf("binding after stale finalization=%+v ok=%v err=%v", got, ok, err)
	}

	finalized, err = s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-current",
		expectedRevision.Add(-time.Second),
		now.Add(2*time.Second),
	)
	if err != nil || len(finalized) != 0 {
		t.Fatalf("stale-revision finalization rows=%+v err=%v", finalized, err)
	}
	got, ok, err = s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingActive {
		t.Fatalf("binding after stale-revision finalization=%+v ok=%v err=%v", got, ok, err)
	}

	finalized, err = s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-current",
		expectedRevision,
		now.Add(3*time.Second),
	)
	if err != nil || len(finalized) != 1 || finalized[0].State != domain.UsageBindingFinalizing {
		t.Fatalf("current finalization rows=%+v err=%v", finalized, err)
	}
	if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingActive, "", now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	sess.IsTerminated = true
	if err := s.UpdateSession(ctx, sess); err != nil {
		t.Fatal(err)
	}
	finalized, err = s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-current",
		expectedRevision,
		now.Add(5*time.Second),
	)
	if err != nil || len(finalized) != 0 {
		t.Fatalf("terminated finalization rows=%+v err=%v", finalized, err)
	}
	got, ok, err = s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingActive {
		t.Fatalf("binding after terminated finalization=%+v ok=%v err=%v", got, ok, err)
	}
}

func TestInsertUsageSourceErrorRedactsArtifactPath(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	secretPath := "/private/transcripts/customer-session.jsonl"

	_, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:    source.BindingID,
		Kind:         domain.UsageSourceKind("invalid"),
		ArtifactPath: secretPath,
		State:        domain.UsageSourcePending,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err == nil {
		t.Fatal("expected invalid source insert to fail")
	}
	if strings.Contains(err.Error(), secretPath) {
		t.Fatalf("store error exposed artifact path: %v", err)
	}
}

func TestInsertUsageSourceRejectsNonObjectParserState(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		ParserStateJSON: `[]`,
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err == nil || !strings.Contains(err.Error(), "parser state") {
		t.Fatalf("insert error = %v, want parser state object error", err)
	}
}

func TestApplyUsageChunkAtomicReplayAndTokenAggregates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	reasoning := int64(3)
	cost := int64(12345)
	event := usageEvent("event-1", now, domain.UsageTokenMetrics{
		InputTokens:         100,
		UncachedInputTokens: 40,
		CacheReadTokens:     50,
		CacheWriteTokens:    10,
		OutputTokens:        20,
		ReasoningTokens:     &reasoning,
	}, &cost)

	result, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
		ByteOffset:      100,
		State:           domain.UsageSourceActive,
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{"input_tokens":100}}}`,
		LastObservedAt:  &now,
		UpdatedAt:       now,
	}, []domain.ModelUsageEvent{event})
	if err != nil {
		t.Fatalf("apply chunk: %v", err)
	}
	if result.InsertedEvents != 1 || result.DuplicateEvents != 0 {
		t.Fatalf("result = %+v, want 1 insert", result)
	}

	result, err = s.ApplyUsageChunk(ctx, source.ID, 100, domain.SourceCursorState{
		ByteOffset:      120,
		State:           domain.UsageSourceActive,
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{"input_tokens":100},"model_id":"gpt-5.6","provider":"openai"}}`,
		LastObservedAt:  &now,
		UpdatedAt:       now.Add(time.Second),
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
	for _, field := range []string{"CostEventCount", "CostNanos", "PricingVersion"} {
		if _, ok := reflect.TypeOf(got).FieldByName(field); ok {
			t.Errorf("token summary still exposes %s", field)
		}
	}
	if got.Tokens.InputTokens != 100 || got.Tokens.OutputTokens != 20 || got.Tokens.ReasoningTokens == nil || *got.Tokens.ReasoningTokens != 3 {
		t.Fatalf("aggregate tokens = %+v", got.Tokens)
	}
	if got.LastObservedAt == nil || !got.LastObservedAt.Equal(now) {
		t.Fatalf("aggregate last observed = %v, want %v", got.LastObservedAt, now)
	}

	if got.EventCount != 1 || got.ReasoningEventCount != 1 {
		t.Fatalf("aggregate coverage counts = %+v, want 1/1", got)
	}

	ctxRow, ok, err := s.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("get source context: ok=%v err=%v", ok, err)
	}
	if ctxRow.Source.ByteOffset != 120 || ctxRow.ProjectID != sess.ProjectID || ctxRow.NativeRootID != "root-thread" ||
		!strings.Contains(ctxRow.Source.ParserStateJSON, `"model_id":"gpt-5.6"`) ||
		ctxRow.InitialModelID != "gpt-5" || ctxRow.BindingState != domain.UsageBindingActive {
		t.Fatalf("source context = %+v", ctxRow)
	}
}

func TestApplyUsageChunkRejectsChangedProviderTimestampForStableKey(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	tokens := domain.UsageTokenMetrics{InputTokens: 10, UncachedInputTokens: 10, OutputTokens: 1}
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
		ByteOffset: 10,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{usageEvent("event-1", now, tokens, nil)}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	_, err := s.ApplyUsageChunk(ctx, source.ID, 10, domain.SourceCursorState{
		ByteOffset: 20,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now.Add(time.Minute),
	}, []domain.ModelUsageEvent{usageEvent("event-1", now.Add(time.Minute), tokens, nil)})
	if !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("timestamp conflict error = %v, want ErrUsageSourceEventConflict", err)
	}
	assertUsageSourceOffset(t, s, source.ID, 10)
}

func TestApplyUsageChunkCanonicalizesOnlyUnknownClaudeProviders(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessClaudeCode)
	now := time.Unix(1700000000, 0).UTC()
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: "claude-root",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "claude-root",
		ArtifactPath:    "/tmp/claude/claude-root.jsonl",
		FileIdentity:    "dev:ino",
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	event := usageEvent("event-1", now, domain.UsageTokenMetrics{
		InputTokens:         10,
		UncachedInputTokens: 10,
		OutputTokens:        1,
	}, nil)
	event.Provider = "claude-code"
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
		ByteOffset: 10,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{event}); err != nil {
		t.Fatalf("seed legacy event: %v", err)
	}
	for index, provider := range []string{"", "unknown"} {
		replayed := event
		replayed.Provider = provider
		expectedOffset := int64(10 + index*10)
		result, err := s.ApplyUsageChunk(ctx, source.ID, expectedOffset, domain.SourceCursorState{
			ByteOffset: expectedOffset + 10,
			State:      domain.UsageSourceActive,
			UpdatedAt:  now,
		}, []domain.ModelUsageEvent{replayed})
		if err != nil {
			t.Fatalf("replay provider %q: %v", provider, err)
		}
		if result.DuplicateEvents != 1 || result.InsertedEvents != 0 {
			t.Fatalf("replay provider %q result = %+v", provider, result)
		}
	}
	conflict := event
	conflict.Provider = "bedrock"
	if _, err := s.ApplyUsageChunk(ctx, source.ID, 30, domain.SourceCursorState{
		ByteOffset: 40,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{conflict}); !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("actual provider conflict = %v, want ErrUsageSourceEventConflict", err)
	}
	assertUsageSourceOffset(t, s, source.ID, 30)
}
func TestApplyUsageChunkRejectsConflictsAndPreservesCursor(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	if _, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{ByteOffset: 50, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-1", now, domain.UsageTokenMetrics{InputTokens: 10, UncachedInputTokens: 10, OutputTokens: 1}, nil),
	}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	conflict := usageEvent("event-1", now, domain.UsageTokenMetrics{InputTokens: 11, UncachedInputTokens: 11, OutputTokens: 1}, nil)
	result, err := s.ApplyUsageChunk(ctx, source.ID, 50, domain.SourceCursorState{ByteOffset: 80, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-2", now, domain.UsageTokenMetrics{InputTokens: 4, UncachedInputTokens: 4, OutputTokens: 1}, nil),
		conflict,
	})
	if !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("conflict err = %v, want ErrUsageSourceEventConflict", err)
	}
	if result.InsertedEvents != 0 || result.DuplicateEvents != 0 {
		t.Fatalf("rolled-back result = %+v, want zero counters", result)
	}
	assertUsageSourceOffset(t, s, source.ID, 50)
	aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(aggregates) != 1 || aggregates[0].EventCount != 1 {
		t.Fatalf("rolled-back chunk persisted events: %+v", aggregates)
	}

	bad := usageEvent("event-2", now, domain.UsageTokenMetrics{
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

func TestUsageBindingWaitsForPersistedCodexChildren(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	const childID = "22222222-2222-4222-8222-222222222222"
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: "11111111-1111-4111-8111-111111111111",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: binding.NativeRootID,
		ArtifactPath:    "/tmp/codex/parent.jsonl",
		FileIdentity:    "parent",
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + childID + `"]}}`,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}

	discovery, err := s.ListUsageDiscoveryBindings(ctx, 8)
	if err != nil || len(discovery) != 1 || discovery[0].ID != binding.ID {
		t.Fatalf("startup discovery bindings = %+v, err=%v", discovery, err)
	}
	if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}
	completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if completed {
		t.Fatal("binding completed before its persisted Codex child was registered")
	}
	got, ok, err := s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingFinalizing {
		t.Fatalf("binding while child missing = %+v, ok=%v err=%v", got, ok, err)
	}

	if _, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: childID,
		SubagentID:      childID,
		ArtifactPath:    "/tmp/codex/child.jsonl",
		FileIdentity:    "child",
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	}); err != nil {
		t.Fatal(err)
	}
	completed, err = s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	if err != nil || !completed {
		t.Fatalf("complete after child registration = %v, err=%v", completed, err)
	}
}

func TestUsageBindingIgnoresChildrenFromSupersededCodexGeneration(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	const (
		rootID  = "11111111-1111-4111-8111-111111111111"
		childID = "22222222-2222-4222-8222-222222222222"
	)
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: rootID,
		State:        domain.UsageBindingFinalizing,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	oldState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + childID + `"]}}`
	emptyState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	for generation, state := range []string{oldState, emptyState} {
		if _, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
			BindingID:       binding.ID,
			Kind:            domain.UsageSourceCodexRollout,
			NativeSessionID: rootID,
			ArtifactPath:    "/tmp/codex/root.jsonl",
			FileIdentity:    fmt.Sprintf("root-%d", generation),
			Generation:      int64(generation),
			ParserStateJSON: state,
			State:           domain.UsageSourceComplete,
			CreatedAt:       now,
			UpdatedAt:       now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	if err != nil || !completed {
		sources, _ := s.ListUsageSourcesForBinding(ctx, binding.ID)
		got, _, _ := s.GetUsageBinding(ctx, sess.ID, sess.Harness, rootID)
		t.Fatalf("completion with superseded child edge = %v, err=%v, binding=%+v, sources=%+v", completed, err, got, sources)
	}
}

func TestUsageBindingIgnoresInvalidCodexDiscoveryStateShapes(t *testing.T) {
	const childID = "22222222-2222-4222-8222-222222222222"
	tests := []struct {
		name  string
		state string
	}{
		{name: "scalar discovered ids", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":"` + childID + `"}}`},
		{name: "object discovered ids", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":{"child":"` + childID + `"}}}`},
		{name: "future version", state: `{"version":2,"source_kind":"codex_rollout","codex":{"discovered_child_ids":["` + childID + `"]}}`},
		{name: "wrong source kind", state: `{"version":1,"source_kind":"claude_main","codex":{"discovered_child_ids":["` + childID + `"]}}`},
		{name: "non object codex payload", state: `{"version":1,"source_kind":"codex_rollout","codex":"not-an-object"}`},
		{name: "noncanonical child", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":["22222222-2222-4222-8222-22222222222A"]}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			ctx := context.Background()
			sess := seedUsageSession(t, s, domain.HarnessCodex)
			now := time.Unix(1700000000, 0).UTC()
			binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
				SessionID:    sess.ID,
				Harness:      sess.Harness,
				NativeRootID: "11111111-1111-4111-8111-111111111111",
				State:        domain.UsageBindingActive,
				FirstSeenAt:  now,
				LastSeenAt:   now,
				UpdatedAt:    now,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
				BindingID:       binding.ID,
				Kind:            domain.UsageSourceCodexRollout,
				NativeSessionID: binding.NativeRootID,
				ArtifactPath:    "/tmp/codex/root.jsonl",
				FileIdentity:    "root",
				ParserStateJSON: tt.state,
				State:           domain.UsageSourceComplete,
				CreatedAt:       now,
				UpdatedAt:       now,
			}); err != nil {
				t.Fatal(err)
			}

			discovery, err := s.ListUsageDiscoveryBindings(ctx, 8)
			if err != nil {
				t.Fatal(err)
			}
			if len(discovery) != 0 {
				t.Fatalf("invalid state invented discovery bindings: %+v", discovery)
			}
			if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
				t.Fatal(err)
			}
			completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
			if err != nil || !completed {
				t.Fatalf("invalid state blocked completion = %v, err=%v", completed, err)
			}
		})
	}
}

func TestUsageBindingRejectsMixedTypeCodexDiscoveryArray(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	const (
		rootID  = "11111111-1111-4111-8111-111111111111"
		childID = "22222222-2222-4222-8222-222222222222"
	)
	binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    sess.ID,
		Harness:      sess.Harness,
		NativeRootID: rootID,
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	state := `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":["` + childID + `",7]}}`
	if _, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: rootID,
		ArtifactPath:    "/tmp/codex/root.jsonl",
		FileIdentity:    "root",
		ParserStateJSON: state,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	}); err != nil {
		t.Fatal(err)
	}

	discovery, err := s.ListUsageDiscoveryBindings(ctx, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(discovery) != 0 {
		t.Fatalf("mixed-type array invented discovery bindings: %+v", discovery)
	}
	if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}
	completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if completed {
		t.Fatal("mixed-type parser state allowed binding completion")
	}
	got, ok, err := s.GetUsageBinding(ctx, sess.ID, sess.Harness, rootID)
	if err != nil || !ok || got.State != domain.UsageBindingFinalizing {
		t.Fatalf("binding after rejected completion = %+v, ok=%v err=%v", got, ok, err)
	}
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
		usageEvent("event-1", now, domain.UsageTokenMetrics{InputTokens: 1, UncachedInputTokens: 1, OutputTokens: 1}, nil),
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
		usageEvent("event-1", now, domain.UsageTokenMetrics{InputTokens: 100, UncachedInputTokens: 100, OutputTokens: 20}, nil),
		usageEvent("event-2", now.Add(time.Second), domain.UsageTokenMetrics{InputTokens: 50, UncachedInputTokens: 50, OutputTokens: 10}, nil),
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

func TestUsageSessionAggregatesParentChildAndMultipleBindingsExactlyOnce(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessCodex)

	newBinding := func(nativeRootID string) domain.UsageBindingRecord {
		t.Helper()
		binding, err := s.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
			SessionID:      sess.ID,
			Harness:        sess.Harness,
			NativeRootID:   nativeRootID,
			InitialModelID: "gpt-5",
			State:          domain.UsageBindingActive,
			FirstSeenAt:    now,
			LastSeenAt:     now,
			UpdatedAt:      now,
		})
		if err != nil {
			t.Fatalf("upsert binding %s: %v", nativeRootID, err)
		}
		return binding
	}
	newSource := func(binding domain.UsageBindingRecord, nativeID, subagentID, path string) domain.UsageSourceRecord {
		t.Helper()
		source, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
			BindingID:       binding.ID,
			Kind:            domain.UsageSourceCodexRollout,
			NativeSessionID: nativeID,
			SubagentID:      subagentID,
			ArtifactPath:    path,
			FileIdentity:    nativeID,
			State:           domain.UsageSourceActive,
			CreatedAt:       now,
			UpdatedAt:       now,
		})
		if err != nil {
			t.Fatalf("insert source %s: %v", nativeID, err)
		}
		return source
	}
	apply := func(source domain.UsageSourceRecord, key string, input, output int64, observedAt time.Time) {
		t.Helper()
		_, err := s.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
			ByteOffset:     10,
			State:          domain.UsageSourceComplete,
			LastObservedAt: &observedAt,
			UpdatedAt:      observedAt,
		}, []domain.ModelUsageEvent{usageEvent(key, observedAt, domain.UsageTokenMetrics{
			InputTokens:         input,
			UncachedInputTokens: input,
			OutputTokens:        output,
		}, nil)})
		if err != nil {
			t.Fatalf("apply source %d: %v", source.ID, err)
		}
	}

	rootBinding := newBinding("root-thread")
	parent := newSource(rootBinding, "root-thread", "", "/tmp/codex/root.jsonl")
	child := newSource(rootBinding, "child-thread", "child-thread", "/tmp/codex/child.jsonl")
	secondBinding := newBinding("resumed-thread")
	resumed := newSource(secondBinding, "resumed-thread", "", "/tmp/codex/resumed.jsonl")
	apply(parent, "parent-event", 100, 20, now)
	apply(child, "child-event", 30, 5, now.Add(time.Second))
	apply(resumed, "resumed-event", 50, 10, now.Add(2*time.Second))
	for _, binding := range []domain.UsageBindingRecord{rootBinding, secondBinding} {
		if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingComplete, "", now); err != nil {
			t.Fatalf("complete binding %d: %v", binding.ID, err)
		}
	}

	sources, err := s.ListUsageSourcesForSession(ctx, sess.ID)
	if err != nil {
		t.Fatalf("list session sources: %v", err)
	}
	if len(sources) != 3 {
		t.Fatalf("session sources = %d, want parent, child, and resumed", len(sources))
	}

	models, err := s.ListUsageModelAggregates(ctx, sess.ID)
	if err != nil {
		t.Fatalf("list model aggregates: %v", err)
	}
	if len(models) != 1 || models[0].EventCount != 3 ||
		models[0].Tokens.InputTokens != 180 || models[0].Tokens.OutputTokens != 35 {
		t.Fatalf("model aggregates = %+v, want input=180 output=35 events=3", models)
	}

	compact, err := s.ListCompactSessionUsage(ctx, sess.ProjectID)
	if err != nil {
		t.Fatalf("list compact usage: %v", err)
	}
	if len(compact) != 1 {
		t.Fatalf("compact rows = %+v, want one", compact)
	}
	row := compact[0]
	if row.TotalTokens != 215 || row.EventCount != 3 ||
		row.BindingCount != 2 || row.CompleteBindingCount != 2 ||
		row.SourceCount != 3 || row.CompleteSourceCount != 3 {
		t.Fatalf("compact aggregate = %+v", row)
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
		SessionID:      sess.ID,
		Harness:        sess.Harness,
		NativeRootID:   "root-thread",
		InitialModelID: "gpt-5",
		State:          domain.UsageBindingActive,
		FirstSeenAt:    now,
		LastSeenAt:     now,
		UpdatedAt:      now,
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
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatalf("insert usage source: %v", err)
	}
	return source
}

func usageEvent(key string, at time.Time, tokens domain.UsageTokenMetrics, cost *int64) domain.ModelUsageEvent {
	pricingVersion := "test-pricing"
	return domain.ModelUsageEvent{
		Provider:       "openai",
		ModelID:        "gpt-5",
		ObservedAt:     at,
		Tokens:         tokens,
		Cost:           domain.UsageCostMetrics{CostNanos: cost, PricingVersion: &pricingVersion},
		SourceEventKey: key,
		CreatedAt:      at,
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
