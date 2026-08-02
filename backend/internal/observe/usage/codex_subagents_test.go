package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

const (
	testCodexParentID     = "11111111-1111-4111-8111-111111111111"
	testCodexChildID      = "22222222-2222-4222-8222-222222222222"
	testCodexGrandchildID = "33333333-3333-4333-8333-333333333333"
)

func TestParseCodexDiscoversSpawnAgentFromMatchingOutput(t *testing.T) {
	source := usageSource(domain.UsageSourceCodexRollout)
	source.Source.NativeSessionID = testCodexParentID
	records := []jsonlRecord{
		{Offset: 0, Data: codexResponseItem(t, map[string]any{
			"type":      "function_call",
			"name":      "spawn_agent",
			"call_id":   "call_spawn_child",
			"arguments": `{"message":"private spawn prompt"}`,
		})},
		{Offset: 200, Data: codexResponseItem(t, map[string]any{
			"type":    "function_call_output",
			"call_id": "call_spawn_child",
			"output":  `{"agent_id":"` + testCodexChildID + `","nickname":"private output"}`,
		})},
		{Offset: 400, Data: codexResponseItem(t, map[string]any{
			"type":    "function_call_output",
			"call_id": "call_spawn_child",
			"output":  `{"agent_id":"` + testCodexChildID + `"}`,
		})},
	}

	result := parseRecords(source, records, 600, time.Unix(1700000000, 0).UTC())
	state := parserStateFromResult(t, result, domain.UsageSourceCodexRollout)
	if len(state.Codex.PendingSpawnCallIDs) != 0 ||
		len(state.Codex.DiscoveredChildIDs) != 1 ||
		state.Codex.DiscoveredChildIDs[0] != testCodexChildID {
		t.Fatalf("Codex spawn state = %+v", state.Codex)
	}
	if strings.Contains(result.Cursor.ParserStateJSON, "private spawn prompt") ||
		strings.Contains(result.Cursor.ParserStateJSON, "private output") {
		t.Fatalf("parser state persisted transcript content: %s", result.Cursor.ParserStateJSON)
	}
}

func TestParseCodexCorrelatesSpawnAgentAcrossParserRestart(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	source := usageSource(domain.UsageSourceCodexRollout)
	first := parseRecords(source, []jsonlRecord{{Data: codexResponseItem(t, map[string]any{
		"type":      "function_call",
		"name":      "spawn_agent",
		"call_id":   "call_across_restart",
		"arguments": `{"message":"never persist this"}`,
	})}}, 200, now)
	firstState := parserStateFromResult(t, first, domain.UsageSourceCodexRollout)
	if len(firstState.Codex.PendingSpawnCallIDs) != 1 ||
		firstState.Codex.PendingSpawnCallIDs[0] != "call_across_restart" {
		t.Fatalf("first parser state = %+v", firstState.Codex)
	}

	source.Source.ParserStateJSON = first.Cursor.ParserStateJSON
	second := parseRecords(source, []jsonlRecord{{Offset: 200, Data: codexResponseItem(t, map[string]any{
		"type":    "function_call_output",
		"call_id": "call_across_restart",
		"output":  `{"agent_id":"` + testCodexChildID + `","reply":"never persist this either"}`,
	})}}, 400, now.Add(time.Second))
	secondState := parserStateFromResult(t, second, domain.UsageSourceCodexRollout)
	if len(secondState.Codex.PendingSpawnCallIDs) != 0 ||
		len(secondState.Codex.DiscoveredChildIDs) != 1 ||
		secondState.Codex.DiscoveredChildIDs[0] != testCodexChildID {
		t.Fatalf("restarted parser state = %+v", secondState.Codex)
	}
}

func TestParseCodexKeepsPendingSpawnAfterMalformedOrUnmatchedOutput(t *testing.T) {
	source := usageSource(domain.UsageSourceCodexRollout)
	records := []jsonlRecord{
		{Data: codexResponseItem(t, map[string]any{
			"type":    "function_call",
			"name":    "spawn_agent",
			"call_id": "call_pending",
		})},
		{Data: codexResponseItem(t, map[string]any{
			"type":    "function_call_output",
			"call_id": "call_unmatched",
			"output":  `{"agent_id":"` + testCodexChildID + `"}`,
		})},
		{Data: codexResponseItem(t, map[string]any{
			"type":    "function_call_output",
			"call_id": "call_pending",
			"output":  `{"agent_id":`,
		})},
	}

	result := parseRecords(source, records, 600, time.Unix(1700000000, 0).UTC())
	state := parserStateFromResult(t, result, domain.UsageSourceCodexRollout)
	if len(state.Codex.PendingSpawnCallIDs) != 1 || state.Codex.PendingSpawnCallIDs[0] != "call_pending" ||
		len(state.Codex.DiscoveredChildIDs) != 0 {
		t.Fatalf("Codex malformed output state = %+v", state.Codex)
	}
	if result.Cursor.AnomalyCount != 1 || result.Cursor.LastErrorCode != domain.UsageErrorMalformedJSONL {
		t.Fatalf("malformed output cursor = %+v", result.Cursor)
	}
}

func TestParseCodexRejectsUnboundedSpawnIdentifiers(t *testing.T) {
	source := usageSource(domain.UsageSourceCodexRollout)
	result := parseRecords(source, []jsonlRecord{{Data: codexResponseItem(t, map[string]any{
		"type":    "function_call",
		"name":    "spawn_agent",
		"call_id": strings.Repeat("a", 257),
	})}}, 300, time.Unix(1700000000, 0).UTC())
	state := parserStateFromResult(t, result, domain.UsageSourceCodexRollout)
	if len(state.Codex.PendingSpawnCallIDs) != 0 || result.Cursor.AnomalyCount != 1 {
		t.Fatalf("unbounded call state/cursor = %+v / %+v", state.Codex, result.Cursor)
	}
}

func TestParseCodexRetainsPendingSpawnWhenChildCapacityIsExceeded(t *testing.T) {
	discovered := make([]string, maxCodexAttributionIDs)
	for index := range discovered {
		discovered[index] = fmt.Sprintf("%08x-0000-4000-8000-%012x", index, index)
	}
	state := &codexParserStateV1{
		PendingSpawnCallIDs: []string{"call_at_capacity"},
		DiscoveredChildIDs:  discovered,
	}
	payload, err := json.Marshal(map[string]any{
		"type":    "function_call_output",
		"call_id": "call_at_capacity",
		"output":  `{"agent_id":"` + testCodexGrandchildID + `"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	result := parseResult{}
	parseCodexResponseItem(payload, state, &result)
	if len(state.PendingSpawnCallIDs) != 1 || state.PendingSpawnCallIDs[0] != "call_at_capacity" ||
		len(state.DiscoveredChildIDs) != maxCodexAttributionIDs || result.Cursor.AnomalyCount != 1 {
		t.Fatalf("capacity pending/discovered/anomalies = %d/%d/%d", len(state.PendingSpawnCallIDs), len(state.DiscoveredChildIDs), result.Cursor.AnomalyCount)
	}
}

func TestIngestorSignalsReconcileOnlyForNewlyCommittedCodexChild(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, source, path, now := seedCodexIngestionSource(t, dataDir)
	call := codexResponseItem(t, map[string]any{
		"type":      "function_call",
		"name":      "spawn_agent",
		"call_id":   "call_committed_child",
		"arguments": `{"message":"private"}`,
	})
	if err := os.WriteFile(path, append(call, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	firstIngestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	first, err := firstIngestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("ingest spawn call: %v", err)
	}
	if first.Reconcile {
		t.Fatalf("spawn call requested reconciliation before an output committed: %+v", first)
	}
	firstState, err := decodeParserState(domain.UsageSourceRecord{
		Kind:            domain.UsageSourceCodexRollout,
		ByteOffset:      int64(len(call) + 1),
		ParserStateJSON: readParserStateJSON(t, dataDir, source.ID),
	})
	if err != nil || len(firstState.Codex.PendingSpawnCallIDs) != 1 {
		t.Fatalf("persisted pending state = %+v, err=%v", firstState, err)
	}

	output := codexResponseItem(t, map[string]any{
		"type":    "function_call_output",
		"call_id": "call_committed_child",
		"output":  `{"agent_id":"` + testCodexChildID + `"}`,
	})
	if err := osAppend(path, string(output)+"\n"); err != nil {
		t.Fatal(err)
	}
	restarted := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now.Add(time.Second) }})
	second, err := restarted.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("ingest matching output after restart: %v", err)
	}
	if !second.Reconcile {
		t.Fatalf("newly committed child did not request reconciliation: %+v", second)
	}

	if err := osAppend(path, string(output)+"\n"); err != nil {
		t.Fatal(err)
	}
	third, err := restarted.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("ingest duplicate output: %v", err)
	}
	if third.Reconcile {
		t.Fatalf("duplicate output requested reconciliation: %+v", third)
	}
}

func TestIngestorMarksUnresolvedCodexSpawnPartialAtStableFinalEOF(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, source, path, now := seedCodexIngestionSource(t, dataDir)
	call := codexResponseItem(t, map[string]any{
		"type":      "function_call",
		"name":      "spawn_agent",
		"call_id":   "call_never_resolved",
		"arguments": `{"message":"private"}`,
	})
	if err := os.WriteFile(path, append(call, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateUsageBindingState(ctx, source.BindingID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}

	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	first, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("initial final ingest: %v", err)
	}
	if first.RetryAt == nil {
		t.Fatalf("initial final ingest did not schedule stability wait: %+v", first)
	}
	now = now.Add(defaultFinalizationWait + time.Second)
	if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
		t.Fatalf("stable final ingest: %v", err)
	}

	got, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("get finalized source: ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete || got.Source.AnomalyCount != 1 ||
		got.Source.LastErrorCode != "unresolved_spawn_call" {
		t.Fatalf("final source = %+v", got.Source)
	}
	bindings, err := store.ListUsageBindingsForSession(ctx, got.SessionID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingPartial {
		t.Fatalf("final binding = %+v, err=%v", bindings, err)
	}
}

func TestCodexSubagentsAggregateRecursivelyExactlyOnce(t *testing.T) {
	ctx := context.Background()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
	parentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
	grandchildPath := filepath.Join(roots.CodexArchived, "rollout-"+testCodexGrandchildID+".jsonl")
	writeCodexRollout(t, parentPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID))
	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, testCodexGrandchildID))
	writeCodexRollout(t, grandchildPath, codexRolloutFixture(t, testCodexGrandchildID, testCodexChildID, 5, 2, ""))

	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill parent: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	parent := latestUsageSource(t, store, binding.ID, testCodexParentID)
	ingestor := NewIngestor(store, IngestorConfig{})
	parentResult, err := ingestor.Ingest(ctx, parent.ID)
	if err != nil || !parentResult.Reconcile {
		t.Fatalf("ingest parent = %+v, err=%v", parentResult, err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile child: %v", err)
	}

	child := latestUsageSource(t, store, binding.ID, testCodexChildID)
	childResult, err := ingestor.Ingest(ctx, child.ID)
	if err != nil || !childResult.Reconcile {
		t.Fatalf("ingest child = %+v, err=%v", childResult, err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile grandchild: %v", err)
	}
	grandchild := latestUsageSource(t, store, binding.ID, testCodexGrandchildID)
	if _, err := ingestor.Ingest(ctx, grandchild.ID); err != nil {
		t.Fatalf("ingest grandchild: %v", err)
	}

	assertTokenAggregate(t, store, session.ID, 177)
	bindings, err := store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("child attribution created extra bindings: %+v, err=%v", bindings, err)
	}
	sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil || len(sources) != 3 {
		t.Fatalf("recursive sources = %+v, err=%v", sources, err)
	}
	for _, source := range sources {
		if source.NativeSessionID != testCodexParentID && source.SubagentID != source.NativeSessionID {
			t.Fatalf("child source attribution = %+v", source)
		}
	}
}

func TestCoordinatorReconcilesLateCodexChildBeforeBindingCompletes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityExited)
	parentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
	writeCodexRollout(t, parentPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID))

	watcher, err := NewTranscriptWatcher(ctx, []string{roots.CodexSessions, roots.CodexArchived})
	if err != nil {
		t.Fatal(err)
	}
	collector := usagesvc.NewCollector(store, roots, nil)
	ingestor := NewIngestor(store, IngestorConfig{FinalizationWait: 50 * time.Millisecond})
	coordinator := NewCoordinator(store, ingestor, watcher, CoordinatorConfig{
		Workers:    1,
		Initialize: collector.BackfillActive,
		Reconcile: func(reconcileCtx context.Context) error {
			return collector.ReconcileSources(reconcileCtx, -1)
		},
	})
	done := coordinator.Start(ctx)
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("usage coordinator did not stop")
		}
	})

	waitForTokenAggregate(t, store, session.ID, 120)
	waitForUsageSourceState(t, store, session.ID, testCodexParentID, domain.UsageSourceComplete)
	binding := onlyUsageBinding(t, store, session.ID)
	if binding.State != domain.UsageBindingFinalizing {
		t.Fatalf("binding completed while discovered child was missing: %+v", binding)
	}

	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, ""))
	waitForWatchableSource(ctx, t, store, childPath)
	waitForTokenAggregate(t, store, session.ID, 170)
	waitForUsageBindingState(t, store, session.ID, domain.UsageBindingComplete)
}

func TestCoordinatorTargetsLateCodexChildBeyondDefaultDiscoveryBatch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityExited)
	parentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
	parentContent := codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID)
	writeCodexRollout(t, parentPath, parentContent)

	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill parent: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	parent := latestUsageSource(t, store, binding.ID, testCodexParentID)
	checkpoint, err := parserCheckpointAfterRead(
		parserCheckpointSample{},
		0,
		int64(len(parentContent)),
		[]byte(parentContent),
	)
	if err != nil {
		t.Fatal(err)
	}
	parserState, err := newParserState(domain.UsageSourceCodexRollout)
	if err != nil {
		t.Fatal(err)
	}
	parserState.Integrity.Checkpoint = checkpoint
	parserState.Codex.DiscoveredChildIDs = []string{testCodexChildID}
	encodedParentState, err := json.Marshal(parserState)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ApplyUsageChunk(ctx, parent.ID, 0, domain.SourceCursorState{
		ByteOffset:      int64(len(parentContent)),
		ParserStateJSON: string(encodedParentState),
		State:           domain.UsageSourceComplete,
		UpdatedAt:       time.Now().UTC(),
	}, nil); err != nil {
		t.Fatal(err)
	}

	oldest := time.Now().UTC().Add(-time.Hour)
	for index := 0; index < 129; index++ {
		rootID := fmt.Sprintf("%08x-0000-4000-8000-%012x", index+10, index+10)
		distractor, err := store.CreateSession(ctx, domain.SessionRecord{
			ProjectID: "codex-subagents",
			Kind:      domain.KindWorker,
			Harness:   domain.HarnessCodex,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: oldest},
			Metadata:  domain.SessionMetadata{AgentSessionID: rootID},
			CreatedAt: oldest,
			UpdatedAt: oldest,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
			SessionID:    distractor.ID,
			Harness:      domain.HarnessCodex,
			NativeRootID: rootID,
			State:        domain.UsageBindingDiscovering,
			FirstSeenAt:  oldest,
			LastSeenAt:   oldest,
			UpdatedAt:    oldest,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	watcher, err := NewTranscriptWatcher(ctx, []string{roots.CodexSessions, roots.CodexArchived})
	if err != nil {
		t.Fatal(err)
	}
	initialReconcile := make(chan struct{}, 1)
	coordinator := NewCoordinator(store, NewIngestor(store, IngestorConfig{FinalizationWait: time.Hour}), watcher, CoordinatorConfig{
		Workers: 1,
		Reconcile: func(reconcileCtx context.Context) error {
			err := collector.ReconcileSources(reconcileCtx, 0)
			select {
			case initialReconcile <- struct{}{}:
			default:
			}
			return err
		},
		ReconcilePath: collector.ReconcilePath,
	})
	done := coordinator.Start(ctx)
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("usage coordinator did not stop")
		}
	})
	select {
	case <-initialReconcile:
	case <-time.After(5 * time.Second):
		t.Fatal("initial bounded reconciliation did not run")
	}

	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, ""))
	waitForWatchableSource(ctx, t, store, childPath)
}

func TestCodexChildArchiveRelocationPreservesCursorWithoutRecount(t *testing.T) {
	ctx := context.Background()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
	parentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
	archivedChildPath := filepath.Join(roots.CodexArchived, filepath.Base(childPath))
	writeCodexRollout(t, parentPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID))
	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, testCodexGrandchildID))

	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill parent: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	ingestor := NewIngestor(store, IngestorConfig{})
	parent := latestUsageSource(t, store, binding.ID, testCodexParentID)
	if result, err := ingestor.Ingest(ctx, parent.ID); err != nil || !result.Reconcile {
		t.Fatalf("ingest parent = %+v, err=%v", result, err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile child: %v", err)
	}
	child := latestUsageSource(t, store, binding.ID, testCodexChildID)
	if result, err := ingestor.Ingest(ctx, child.ID); err != nil || !result.Reconcile {
		t.Fatalf("ingest child = %+v, err=%v", result, err)
	}
	assertTokenAggregate(t, store, session.ID, 170)
	before, ok, err := store.GetUsageSourceForIngestion(ctx, child.ID)
	if err != nil || !ok {
		t.Fatalf("read child before relocation: ok=%v err=%v", ok, err)
	}

	if err := os.MkdirAll(filepath.Dir(archivedChildPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(childPath, archivedChildPath); err != nil {
		t.Fatal(err)
	}
	missing, err := ingestor.Ingest(ctx, child.ID)
	if err == nil || !missing.Reconcile {
		t.Fatalf("missing active child = %+v, err=%v", missing, err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile archived child: %v", err)
	}
	relocated := latestUsageSource(t, store, binding.ID, testCodexChildID)
	if relocated.ID == child.ID || relocated.ArtifactPath != canonicalTranscriptPath(archivedChildPath) ||
		relocated.ByteOffset != before.Source.ByteOffset || relocated.ParserStateJSON != before.Source.ParserStateJSON {
		t.Fatalf("relocated child = %+v, before=%+v", relocated, before.Source)
	}
	if _, err := ingestor.Ingest(ctx, relocated.ID); err != nil {
		t.Fatalf("ingest relocated child: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 170)
}

func TestCodexChildCheckpointMismatchRevalidatesIdentityAndParent(t *testing.T) {
	tests := []struct {
		name              string
		replacementID     string
		replacementParent string
	}{
		{name: "wrong child id", replacementID: testCodexGrandchildID, replacementParent: testCodexParentID},
		{name: "wrong parent", replacementID: testCodexChildID, replacementParent: testCodexGrandchildID},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
			parentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
			childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
			writeCodexRollout(t, parentPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID))
			writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, ""))

			collector := usagesvc.NewCollector(store, roots, nil)
			if err := collector.BackfillActive(ctx); err != nil {
				t.Fatalf("backfill parent: %v", err)
			}
			binding := onlyUsageBinding(t, store, session.ID)
			ingestor := NewIngestor(store, IngestorConfig{})
			parent := latestUsageSource(t, store, binding.ID, testCodexParentID)
			if result, err := ingestor.Ingest(ctx, parent.ID); err != nil || !result.Reconcile {
				t.Fatalf("ingest parent = %+v, err=%v", result, err)
			}
			if err := collector.ReconcileSources(ctx, -1); err != nil {
				t.Fatalf("reconcile child: %v", err)
			}
			child := latestUsageSource(t, store, binding.ID, testCodexChildID)
			if _, err := ingestor.Ingest(ctx, child.ID); err != nil {
				t.Fatalf("ingest child: %v", err)
			}
			assertTokenAggregate(t, store, session.ID, 170)

			beforeIdentity, err := usagesvc.SourceIdentity(context.Background(), childPath)
			if err != nil {
				t.Fatal(err)
			}
			writeCodexRollout(t, childPath, codexRolloutFixture(
				t,
				tt.replacementID,
				tt.replacementParent,
				900,
				100,
				"",
			))
			afterIdentity, err := usagesvc.SourceIdentity(context.Background(), childPath)
			if err != nil {
				t.Fatal(err)
			}
			if afterIdentity != beforeIdentity {
				t.Fatalf("same-inode fixture changed identity: %q != %q", beforeIdentity, afterIdentity)
			}
			result, err := ingestor.Ingest(ctx, child.ID)
			if err != nil {
				t.Fatalf("detect child replacement: %v", err)
			}
			if result.ReplacementSourceID != 0 || !result.Reconcile {
				t.Fatalf("unvalidated replacement result = %+v", result)
			}
			if err := collector.ReconcilePath(ctx, childPath); err != nil {
				t.Fatalf("reconcile invalid replacement: %v", err)
			}
			sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
			if err != nil {
				t.Fatal(err)
			}
			childGenerations := 0
			for _, source := range sources {
				if source.NativeSessionID == testCodexChildID {
					childGenerations++
				}
			}
			if childGenerations != 1 {
				t.Fatalf("invalid child replacement registered %d generations: %+v", childGenerations, sources)
			}
			assertTokenAggregate(t, store, session.ID, 170)
		})
	}
}

func TestCodexChildReplacementDoesNotChangeDurableDirectParent(t *testing.T) {
	ctx := context.Background()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
	rootPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
	alternateParentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexGrandchildID)
	rootContent := strings.TrimSuffix(
		codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID),
		"\n",
	)
	alternateCallID := "call_spawn_alternate_parent"
	rootContent += "\n" + string(codexResponseItem(t, map[string]any{
		"type":    "function_call",
		"name":    "spawn_agent",
		"call_id": alternateCallID,
	})) + "\n" + string(codexResponseItem(t, map[string]any{
		"type":    "function_call_output",
		"call_id": alternateCallID,
		"output":  `{"agent_id":"` + testCodexGrandchildID + `"}`,
	})) + "\n"
	writeCodexRollout(t, rootPath, rootContent)
	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, ""))
	writeCodexRollout(t, alternateParentPath, codexRolloutFixture(
		t,
		testCodexGrandchildID,
		testCodexParentID,
		5,
		2,
		testCodexChildID,
	))

	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill root: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	ingestor := NewIngestor(store, IngestorConfig{})
	root := latestUsageSource(t, store, binding.ID, testCodexParentID)
	if _, err := ingestor.Ingest(ctx, root.ID); err != nil {
		t.Fatalf("ingest root: %v", err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("register children: %v", err)
	}
	child := latestUsageSource(t, store, binding.ID, testCodexChildID)
	alternateParent := latestUsageSource(t, store, binding.ID, testCodexGrandchildID)
	if _, err := ingestor.Ingest(ctx, child.ID); err != nil {
		t.Fatalf("ingest child: %v", err)
	}
	if _, err := ingestor.Ingest(ctx, alternateParent.ID); err != nil {
		t.Fatalf("ingest alternate parent: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 177)

	writeCodexRollout(t, childPath, codexRolloutFixture(
		t,
		testCodexChildID,
		testCodexGrandchildID,
		90,
		20,
		"",
	))
	result, err := ingestor.Ingest(ctx, child.ID)
	if err != nil {
		t.Fatalf("detect child rewrite: %v", err)
	}
	if !result.Reconcile || result.ReconcilePath != canonicalTranscriptPath(childPath) {
		t.Fatalf("rewrite result = %+v", result)
	}
	if err := collector.ReconcilePath(ctx, childPath); err != nil {
		t.Fatalf("reconcile changed parent: %v", err)
	}
	sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		t.Fatal(err)
	}
	childGenerations := 0
	for _, source := range sources {
		if source.NativeSessionID == testCodexChildID {
			childGenerations++
			if source.ID != child.ID || source.State != domain.UsageSourceComplete ||
				source.LastErrorCode != domain.UsageErrorArtifactReplaced {
				t.Fatalf("changed-parent child source = %+v", source)
			}
		}
	}
	if childGenerations != 1 {
		t.Fatalf("child generations = %d, want one rejected generation", childGenerations)
	}
	assertTokenAggregate(t, store, session.ID, 177)
}

func TestCodexChildCheckpointMismatchReconcilesValidatedGeneration(t *testing.T) {
	ctx := context.Background()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
	parentPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	childPath := activeCodexRolloutPath(roots.CodexSessions, testCodexChildID)
	writeCodexRollout(t, parentPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, testCodexChildID))
	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 40, 10, ""))

	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill parent: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	ingestor := NewIngestor(store, IngestorConfig{})
	parent := latestUsageSource(t, store, binding.ID, testCodexParentID)
	if result, err := ingestor.Ingest(ctx, parent.ID); err != nil || !result.Reconcile {
		t.Fatalf("ingest parent = %+v, err=%v", result, err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile child: %v", err)
	}
	child := latestUsageSource(t, store, binding.ID, testCodexChildID)
	if _, err := ingestor.Ingest(ctx, child.ID); err != nil {
		t.Fatalf("ingest child: %v", err)
	}

	writeCodexRollout(t, childPath, codexRolloutFixture(t, testCodexChildID, testCodexParentID, 90, 20, ""))
	result, err := ingestor.Ingest(ctx, child.ID)
	if err != nil {
		t.Fatalf("detect child rewrite: %v", err)
	}
	if result.ReplacementSourceID != 0 || !result.Reconcile || result.ReconcilePath != canonicalTranscriptPath(childPath) {
		t.Fatalf("rewrite result = %+v, want child reconciliation", result)
	}
	if err := collector.ReconcilePath(ctx, childPath); err != nil {
		t.Fatalf("reconcile validated child: %v", err)
	}
	replacement := latestUsageSource(t, store, binding.ID, testCodexChildID)
	if replacement.ID == child.ID || replacement.Generation != child.Generation+1 || replacement.ByteOffset != 0 {
		t.Fatalf("validated replacement = %+v, previous=%+v", replacement, child)
	}
	if _, err := ingestor.Ingest(ctx, replacement.ID); err != nil {
		t.Fatalf("ingest validated replacement: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 280)
}

func TestCodexRootReplacementRejectsMismatchedSessionMeta(t *testing.T) {
	tests := []struct {
		name          string
		replacementID string
		parentID      string
		atomic        bool
	}{
		{
			name:          "mismatched root id",
			replacementID: testCodexChildID,
			atomic:        true,
		},
		{
			name:          "root rewritten as child",
			replacementID: testCodexParentID,
			parentID:      testCodexChildID,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
			rootPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
			writeCodexRollout(t, rootPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, ""))
			collector := usagesvc.NewCollector(store, roots, nil)
			if err := collector.BackfillActive(ctx); err != nil {
				t.Fatalf("backfill root: %v", err)
			}
			binding := onlyUsageBinding(t, store, session.ID)
			root := latestUsageSource(t, store, binding.ID, testCodexParentID)
			ingestor := NewIngestor(store, IngestorConfig{})
			if _, err := ingestor.Ingest(ctx, root.ID); err != nil {
				t.Fatalf("ingest root: %v", err)
			}

			replacement := codexRolloutFixture(t, test.replacementID, test.parentID, 900, 100, "")
			if test.atomic {
				replacementPath := rootPath + ".replacement"
				writeCodexRollout(t, replacementPath, replacement)
				if err := os.Rename(replacementPath, rootPath); err != nil {
					t.Fatal(err)
				}
			} else {
				beforeIdentity, err := usagesvc.SourceIdentity(context.Background(), rootPath)
				if err != nil {
					t.Fatal(err)
				}
				writeCodexRollout(t, rootPath, replacement)
				afterIdentity, err := usagesvc.SourceIdentity(context.Background(), rootPath)
				if err != nil {
					t.Fatal(err)
				}
				if afterIdentity != beforeIdentity {
					t.Fatalf("same-inode fixture changed identity: %q != %q", beforeIdentity, afterIdentity)
				}
			}

			result, err := ingestor.Ingest(ctx, root.ID)
			if err != nil {
				t.Fatalf("detect root replacement: %v", err)
			}
			if result.ReplacementSourceID != 0 || !result.Reconcile || result.ReconcilePath != canonicalTranscriptPath(rootPath) {
				t.Fatalf("replacement result = %+v, want root reconciliation", result)
			}
			if err := collector.ReconcilePath(ctx, rootPath); err != nil {
				t.Fatalf("reconcile invalid root: %v", err)
			}
			sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(sources) != 1 || sources[0].State != domain.UsageSourceComplete ||
				sources[0].LastErrorCode != domain.UsageErrorArtifactReplaced {
				t.Fatalf("invalid replacement sources = %+v", sources)
			}
			assertTokenAggregate(t, store, session.ID, 120)
		})
	}
}

func TestCodexRootReplacementReconcilesValidatedGeneration(t *testing.T) {
	ctx := context.Background()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
	rootPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	writeCodexRollout(t, rootPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, ""))
	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill root: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	root := latestUsageSource(t, store, binding.ID, testCodexParentID)
	ingestor := NewIngestor(store, IngestorConfig{})
	if _, err := ingestor.Ingest(ctx, root.ID); err != nil {
		t.Fatalf("ingest root: %v", err)
	}

	replacementPath := rootPath + ".replacement"
	writeCodexRollout(t, replacementPath, codexRolloutFixture(t, testCodexParentID, "", 200, 30, ""))
	if err := os.Rename(replacementPath, rootPath); err != nil {
		t.Fatal(err)
	}
	result, err := ingestor.Ingest(ctx, root.ID)
	if err != nil {
		t.Fatalf("detect root replacement: %v", err)
	}
	if result.ReplacementSourceID != 0 || !result.Reconcile || result.ReconcilePath != canonicalTranscriptPath(rootPath) {
		t.Fatalf("replacement result = %+v, want root reconciliation", result)
	}
	if err := collector.ReconcilePath(ctx, rootPath); err != nil {
		t.Fatalf("reconcile valid root: %v", err)
	}
	replacement := latestUsageSource(t, store, binding.ID, testCodexParentID)
	if replacement.ID == root.ID || replacement.Generation != root.Generation+1 || replacement.ByteOffset != 0 {
		t.Fatalf("validated replacement = %+v, previous=%+v", replacement, root)
	}
	if _, err := ingestor.Ingest(ctx, replacement.ID); err != nil {
		t.Fatalf("ingest replacement: %v", err)
	}
	assertTokenAggregate(t, store, session.ID, 350)
}

func TestCodexIngestorRejectsMetadataChangedAfterRegistration(t *testing.T) {
	ctx := context.Background()
	store, session, roots := seedCodexRolloutSession(t, domain.ActivityIdle)
	rootPath := activeCodexRolloutPath(roots.CodexSessions, testCodexParentID)
	writeCodexRollout(t, rootPath, codexRolloutFixture(t, testCodexParentID, "", 100, 20, ""))
	collector := usagesvc.NewCollector(store, roots, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("register root: %v", err)
	}
	binding := onlyUsageBinding(t, store, session.ID)
	root := latestUsageSource(t, store, binding.ID, testCodexParentID)
	beforeIdentity, err := usagesvc.SourceIdentity(context.Background(), rootPath)
	if err != nil {
		t.Fatal(err)
	}
	writeCodexRollout(t, rootPath, codexRolloutFixture(t, testCodexChildID, "", 900, 100, ""))
	afterIdentity, err := usagesvc.SourceIdentity(context.Background(), rootPath)
	if err != nil {
		t.Fatal(err)
	}
	if afterIdentity != beforeIdentity {
		t.Fatalf("same-inode fixture changed identity: %q != %q", beforeIdentity, afterIdentity)
	}

	result, err := NewIngestor(store, IngestorConfig{}).Ingest(ctx, root.ID)
	if err != nil {
		t.Fatalf("ingest changed metadata: %v", err)
	}
	if !result.Reconcile || result.ReconcilePath != canonicalTranscriptPath(rootPath) {
		t.Fatalf("ingest result = %+v, want metadata reconciliation", result)
	}
	got, ok, err := store.GetUsageSourceForIngestion(ctx, root.ID)
	if err != nil || !ok {
		t.Fatalf("load retired source: ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete || got.Source.LastErrorCode != domain.UsageErrorArtifactReplaced {
		t.Fatalf("changed metadata source = %+v", got.Source)
	}
	assertTokenAggregate(t, store, session.ID, 0)
}

func codexResponseItem(t *testing.T, payload map[string]any) []byte {
	t.Helper()
	line, err := json.Marshal(map[string]any{
		"timestamp": "2026-07-28T10:00:00Z",
		"type":      "response_item",
		"payload":   payload,
	})
	if err != nil {
		t.Fatal(err)
	}
	return line
}

func codexSessionMetaLine(t *testing.T, id, parentID string) []byte {
	t.Helper()
	payload := map[string]any{"id": id, "model_provider": "openai"}
	if parentID != "" {
		payload["source"] = map[string]any{
			"subagent": map[string]any{
				"thread_spawn": map[string]any{"parent_thread_id": parentID},
			},
		}
	}
	line, err := json.Marshal(map[string]any{
		"timestamp": "2026-07-28T10:00:00Z",
		"type":      "session_meta",
		"payload":   payload,
	})
	if err != nil {
		t.Fatal(err)
	}
	return line
}

func seedCodexRolloutSession(
	t *testing.T,
	activity domain.ActivityState,
) (*sqlite.Store, domain.SessionRecord, usagesvc.SourceRoots) {
	t.Helper()
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Now().UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "codex-subagents", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "codex-subagents",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: activity, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{AgentSessionID: testCodexParentID},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	return store, session, usagesvc.SourceRoots{
		CodexSessions: filepath.Join(base, "sessions"),
		CodexArchived: filepath.Join(base, "archived_sessions"),
	}
}

func codexRolloutFixture(t *testing.T, id, parentID string, input, output int64, spawnedChildID string) string {
	t.Helper()
	records := [][]byte{
		codexSessionMetaLine(t, id, parentID),
		[]byte(`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`),
		codexTokenLine("2026-07-28T10:00:00Z", input, 0, 0, output, 0),
	}
	if spawnedChildID != "" {
		callID := "call_spawn_" + strings.ReplaceAll(spawnedChildID, "-", "_")
		records = append(records,
			codexResponseItem(t, map[string]any{
				"type":      "function_call",
				"name":      "spawn_agent",
				"call_id":   callID,
				"arguments": `{"message":"private child task"}`,
			}),
			codexResponseItem(t, map[string]any{
				"type":    "function_call_output",
				"call_id": callID,
				"output":  `{"agent_id":"` + spawnedChildID + `","nickname":"private"}`,
			}),
		)
	}
	return string(bytes.Join(records, []byte{'\n'})) + "\n"
}

func activeCodexRolloutPath(root, id string) string {
	return filepath.Join(root, "2026", "07", "28", "rollout-"+id+".jsonl")
}

func writeCodexRollout(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func onlyUsageBinding(t *testing.T, store *sqlite.Store, sessionID domain.SessionID) domain.UsageBindingRecord {
	t.Helper()
	bindings, err := store.ListUsageBindingsForSession(context.Background(), sessionID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("usage bindings = %+v, err=%v", bindings, err)
	}
	return bindings[0]
}

func latestUsageSource(t *testing.T, store *sqlite.Store, bindingID int64, nativeID string) domain.UsageSourceRecord {
	t.Helper()
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindingID)
	if err != nil {
		t.Fatal(err)
	}
	var latest domain.UsageSourceRecord
	for _, source := range sources {
		if source.NativeSessionID != nativeID {
			continue
		}
		if latest.ID == 0 || source.Generation > latest.Generation ||
			(source.Generation == latest.Generation && source.ID > latest.ID) {
			latest = source
		}
	}
	if latest.ID == 0 {
		t.Fatalf("usage source for native session %q not found: %+v", nativeID, sources)
	}
	return latest
}

func waitForUsageSourceState(
	t *testing.T,
	store *sqlite.Store,
	sessionID domain.SessionID,
	nativeID string,
	want domain.UsageSourceState,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		bindings, err := store.ListUsageBindingsForSession(context.Background(), sessionID)
		if err != nil {
			t.Fatal(err)
		}
		if len(bindings) == 1 {
			sources, listErr := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
			if listErr != nil {
				t.Fatal(listErr)
			}
			for _, source := range sources {
				if source.NativeSessionID == nativeID && source.State == want {
					return
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	binding := onlyUsageBinding(t, store, sessionID)
	source := latestUsageSource(t, store, binding.ID, nativeID)
	t.Fatalf("source state = %s, want %s: %+v", source.State, want, source)
}

func waitForUsageBindingState(
	t *testing.T,
	store *sqlite.Store,
	sessionID domain.SessionID,
	want domain.UsageBindingState,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		binding := onlyUsageBinding(t, store, sessionID)
		if binding.State == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	binding := onlyUsageBinding(t, store, sessionID)
	t.Fatalf("binding state = %s, want %s: %+v", binding.State, want, binding)
}
