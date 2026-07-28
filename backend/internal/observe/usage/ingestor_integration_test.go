package usage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestIngestorCollectsCodexSourceDiscoveredAfterStartup(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{AgentSessionID: "native-late"},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "sessions")
	collector := usagesvc.NewCollector(store, usagesvc.SourceRoots{CodexSessions: root}, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	path := filepath.Join(root, "2026", "07", "28", "rollout-native-late.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestAllWatchable(ctx, t, store, ingestor)
	assertTokenAggregate(t, store, session.ID, 120)
}

func TestIngestorCompletesCodexExitWhoseSourceAppearsLate(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityExited, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{AgentSessionID: "native-final"},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "sessions")
	collector := usagesvc.NewCollector(store, usagesvc.SourceRoots{CodexSessions: root}, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	session.IsTerminated = true
	session.UpdatedAt = now.Add(time.Second)
	if err := store.UpdateSession(ctx, session); err != nil {
		t.Fatalf("terminate session after finalization registration: %v", err)
	}

	path := filepath.Join(root, "2026", "07", "28", "rollout-native-final.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestAllWatchable(ctx, t, store, ingestor)
	assertTokenAggregate(t, store, session.ID, 120)
	now = now.Add(defaultFinalizationWait + time.Second)
	ingestAllWatchable(ctx, t, store, ingestor)
	bindings, err := store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingComplete {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
}

func TestIngestorPreservesCursorWhenCodexRolloutMovesToArchive(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{AgentSessionID: "native-move"},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionsRoot := filepath.Join(t.TempDir(), "sessions")
	archiveRoot := filepath.Join(t.TempDir(), "archived_sessions")
	activePath := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-native-move.jsonl")
	if err := os.MkdirAll(filepath.Dir(activePath), 0o700); err != nil {
		t.Fatal(err)
	}
	initial := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(activePath, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	collector := usagesvc.NewCollector(store, usagesvc.SourceRoots{
		CodexSessions: sessionsRoot,
		CodexArchived: archiveRoot,
	}, nil)
	if err := collector.BackfillActive(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestAllWatchable(ctx, t, store, ingestor)
	assertTokenAggregate(t, store, session.ID, 120)

	archivedPath := filepath.Join(archiveRoot, filepath.Base(activePath))
	if err := os.MkdirAll(filepath.Dir(archivedPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(activePath, archivedPath); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	sources, err := store.ListWatchableUsageSources(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range sources {
		result, ingestErr := ingestor.Ingest(ctx, source.ID)
		if ingestErr != nil && result.RetryAt == nil {
			t.Fatalf("ingest relocated source %d: %v", source.ID, ingestErr)
		}
	}
	if err := collector.ReconcileSources(ctx, -1); err != nil {
		t.Fatalf("relocation reconcile: %v", err)
	}
	ingestAllWatchable(ctx, t, store, ingestor)
	assertTokenAggregate(t, store, session.ID, 120)

	file, err := os.OpenFile(archivedPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(append(codexTokenLine("2026-07-28T10:01:00Z", 150, 90, 0, 30, 8), '\n')); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	_ = file.Close()
	now = now.Add(30 * time.Second)
	ingestAllWatchable(ctx, t, store, ingestor)
	assertTokenAggregate(t, store, session.ID, 180)
}

func TestCoordinatorCollectsCodexUsageFromFilesystemEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Now().UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{AgentSessionID: "native-watch"},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	base := t.TempDir()
	sessionsRoot := filepath.Join(base, "sessions")
	archiveRoot := filepath.Join(base, "archived_sessions")
	transcript := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-native-watch.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	initial := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n"
	if err := os.WriteFile(transcript, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}

	watcher, err := NewTranscriptWatcher([]string{sessionsRoot, archiveRoot})
	if err != nil {
		t.Fatal(err)
	}
	collector := usagesvc.NewCollector(store, usagesvc.SourceRoots{
		CodexSessions: sessionsRoot,
		CodexArchived: archiveRoot,
	}, nil)
	ingestor := NewIngestor(store, IngestorConfig{})
	coordinator := NewCoordinator(store, ingestor, watcher, CoordinatorConfig{
		Workers:    1,
		Initialize: collector.BackfillActive,
		Reconcile: func(reconcileCtx context.Context) error {
			return collector.ReconcileSources(reconcileCtx, 0)
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

	waitForWatchableSource(ctx, t, store, transcript)
	appendJSONLRecord(t, transcript, codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5))
	waitForTokenAggregate(t, store, session.ID, 120)

	appendJSONLRecord(t, transcript, codexTokenLine("2026-07-28T10:01:00Z", 150, 90, 0, 30, 8))
	waitForTokenAggregate(t, store, session.ID, 180)
}

func TestIngestorPersistsAppendOnlyUsageAcrossRestartAndFinalization(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      domain.HarnessCodex,
		NativeRootID: "native-1",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := t.TempDir() + "/rollout.jsonl"
	initial := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-01T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := usagesvc.SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:     binding.ID,
		Kind:          domain.UsageSourceCodexRollout,
		ArtifactPath:  path,
		FileIdentity:  identity,
		ParserVersion: usagesvc.CodexRolloutParserVersion,
		State:         domain.UsageSourcePending,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestSourceFully(ctx, t, ingestor, source.ID)
	assertTokenAggregate(t, store, session.ID, 120)

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(append(codexTokenLine("2026-07-01T10:00:01Z", 150, 90, 0, 30, 8), '\n')); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	_ = file.Close()
	now = now.Add(30 * time.Second)
	ingestSourceFully(ctx, t, ingestor, source.ID)
	assertTokenAggregate(t, store, session.ID, 180)

	restarted := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestSourceFully(ctx, t, restarted, source.ID)
	assertTokenAggregate(t, store, session.ID, 180)

	replacement := `{"type":"session_meta","payload":{"model_provider":"openai-replacement"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6-mini"}}` + "\n" +
		string(codexTokenLine("2026-07-01T11:00:00Z", 10, 5, 0, 2, 1)) + "\n"
	if err := os.WriteFile(path, []byte(replacement), 0o600); err != nil {
		t.Fatal(err)
	}
	ingestSourceFully(ctx, t, restarted, source.ID)
	ingestAllWatchable(ctx, t, store, restarted)
	assertTokenAggregate(t, store, session.ID, 192)
	sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil || len(sources) != 2 ||
		sources[0].State != domain.UsageSourceComplete ||
		sources[0].LastErrorCode != domain.UsageErrorArtifactReplaced {
		t.Fatalf("replacement sources=%+v err=%v", sources, err)
	}

	if _, err := store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}
	ingestAllWatchable(ctx, t, store, restarted)
	if err := osAppend(path, string(codexTokenLine("2026-07-01T11:00:01Z", 15, 8, 0, 3, 1))); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	ingestAllWatchable(ctx, t, store, restarted)
	assertTokenAggregate(t, store, session.ID, 192)
	now = now.Add(defaultFinalizationWait + time.Second)
	ingestAllWatchable(ctx, t, store, restarted)
	assertTokenAggregate(t, store, session.ID, 198)
	got, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("source ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete {
		t.Fatalf("source state = %s", got.Source.State)
	}
	bindings, err := store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingPartial {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
}

func TestIngestorLateAppendReturnsCompletedBindingToFinalizing(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "native-late-append",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	content := `{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-01T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := usagesvc.SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:     binding.ID,
		Kind:          domain.UsageSourceCodexRollout,
		ArtifactPath:  path,
		FileIdentity:  identity,
		ParserVersion: usagesvc.CodexRolloutParserVersion,
		State:         domain.UsageSourcePending,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestSourceFully(ctx, t, ingestor, source.ID)
	if _, err := store.MarkUsageSourceState(ctx, source.ID, domain.UsageSourceComplete, "", nil, now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteUsageBindingIfSettled(ctx, binding.ID, now); err != nil {
		t.Fatal(err)
	}

	appendJSONLRecord(t, path, codexTokenLine("2026-07-01T10:01:00Z", 150, 90, 0, 30, 8))
	now = now.Add(time.Second)
	result, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.RetryAt == nil {
		t.Fatal("late append did not schedule a finalization quiet period")
	}
	bindings, err := store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingFinalizing {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	now = now.Add(defaultFinalizationWait + time.Second)
	if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
		t.Fatal(err)
	}
	bindings, err = store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingComplete {
		t.Fatalf("settled bindings=%+v err=%v", bindings, err)
	}
	assertTokenAggregate(t, store, session.ID, 180)
}

func TestIngestorStopsRetryingConflictingNativeEvent(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1700000000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "usage", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      domain.HarnessClaudeCode,
		NativeRootID: "claude-root",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "claude-root.jsonl")
	line := `{"type":"assistant","uuid":"native-message","message":{"id":"msg-1","model":"claude-x","stop_reason":"end_turn","usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := usagesvc.SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "claude-root",
		ArtifactPath:    path,
		FileIdentity:    identity,
		ParserVersion:   usagesvc.ClaudeJSONLParserVersion,
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	contextSource, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("source ok=%v err=%v", ok, err)
	}
	parsed := parseRecords(contextSource, []jsonlRecord{{Data: []byte(line), Offset: 0}}, int64(len(line)), now)
	conflict := parsed.Events[0]
	conflict.SourceUsageHash = "sha256:different"
	if _, err := store.ApplyUsageChunk(ctx, source.ID, 0, domain.SourceCursorState{
		ByteOffset: 0,
		State:      domain.UsageSourcePending,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{conflict}); err != nil {
		t.Fatal(err)
	}

	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
		t.Fatalf("conflict ingest: %v", err)
	}
	got, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("source ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete ||
		got.Source.LastErrorCode != domain.UsageErrorSourceEventConflict {
		t.Fatalf("source=%+v", got.Source)
	}
}

func TestRetryDelayUsesBoundedBackoff(t *testing.T) {
	tests := []struct {
		failure int64
		want    time.Duration
	}{
		{failure: 1, want: 30 * time.Second},
		{failure: 2, want: time.Minute},
		{failure: 3, want: 2 * time.Minute},
		{failure: 4, want: 5 * time.Minute},
		{failure: 20, want: 5 * time.Minute},
	}
	for _, test := range tests {
		if got := retryDelay(test.failure); got != test.want {
			t.Errorf("retryDelay(%d)=%s, want %s", test.failure, got, test.want)
		}
	}
}

func ingestAllWatchable(ctx context.Context, t *testing.T, store *sqlite.Store, ingestor *Ingestor) {
	t.Helper()
	for pass := 0; pass < 16; pass++ {
		sources, err := store.ListWatchableUsageSources(ctx)
		if err != nil {
			t.Fatal(err)
		}
		again := false
		for _, source := range sources {
			result, ingestErr := ingestor.Ingest(ctx, source.ID)
			if ingestErr != nil && result.RetryAt == nil {
				t.Fatalf("ingest source %d: %v", source.ID, ingestErr)
			}
			again = again || result.More || result.Refresh
		}
		if !again {
			return
		}
	}
	t.Fatal("usage ingestion did not settle")
}

func ingestSourceFully(ctx context.Context, t *testing.T, ingestor *Ingestor, sourceID int64) {
	t.Helper()
	for pass := 0; pass < 16; pass++ {
		result, err := ingestor.Ingest(ctx, sourceID)
		if err != nil && result.RetryAt == nil {
			t.Fatalf("ingest source %d: %v", sourceID, err)
		}
		if !result.More {
			return
		}
	}
	t.Fatalf("usage source %d did not reach EOF", sourceID)
}

func assertTokenAggregate(t *testing.T, store *sqlite.Store, sessionID domain.SessionID, total int64) {
	t.Helper()
	aggregates, err := store.ListUsageModelAggregates(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	var got int64
	for _, aggregate := range aggregates {
		got += aggregate.Tokens.InputTokens + aggregate.Tokens.OutputTokens
	}
	if got != total {
		t.Fatalf("total tokens = %d, want %d; aggregates=%+v", got, total, aggregates)
	}
}

func waitForWatchableSource(ctx context.Context, t *testing.T, store *sqlite.Store, path string) {
	t.Helper()
	path = canonicalTranscriptPath(path)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		sources, err := store.ListWatchableUsageSources(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, source := range sources {
			if canonicalTranscriptPath(source.ArtifactPath) == path {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("usage source %q was not registered", path)
}

func appendJSONLRecord(t *testing.T, path string, record []byte) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(append(record, '\n')); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func waitForTokenAggregate(t *testing.T, store *sqlite.Store, sessionID domain.SessionID, total int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		aggregates, err := store.ListUsageModelAggregates(context.Background(), sessionID)
		if err != nil {
			t.Fatal(err)
		}
		var got int64
		for _, aggregate := range aggregates {
			got += aggregate.Tokens.InputTokens + aggregate.Tokens.OutputTokens
		}
		if got == total {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	assertTokenAggregate(t, store, sessionID, total)
}
