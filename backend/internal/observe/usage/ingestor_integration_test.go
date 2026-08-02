package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestIngestorPersistsVersionedCodexParserStateAcrossChunks(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, source, path, now := seedCodexIngestionSource(t, dataDir)

	first := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}` + "\n" +
		string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
		t.Fatalf("ingest first chunk: %v", err)
	}

	state := readParserStateJSON(t, dataDir, source.ID)
	assertCodexParserState(t, state, 100, "gpt-5.6", "openai")

	second := string(codexTokenLine("2026-07-28T10:01:00Z", 160, 90, 0, 35, 8)) + "\n"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(second); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
		t.Fatalf("ingest second chunk: %v", err)
	}
	assertTokenAggregate(t, store, sourceSessionID(t, store, source.ID), 195)
	assertCodexParserState(t, readParserStateJSON(t, dataDir, source.ID), 160, "gpt-5.6", "openai")
}

func TestIngestorRejectsInvalidPersistedParserStateWithoutAdvancing(t *testing.T) {
	tests := []struct {
		name            string
		state           string
		replaceArtifact bool
	}{
		{name: "malformed", state: `{"version":`},
		{name: "malformed after artifact replacement", state: `{"version":`, replaceArtifact: true},
		{name: "non object", state: `[]`},
		{name: "unknown field", state: `{"version":1,"source_kind":"codex_rollout","codex":{},"extra":true}`},
		{name: "wrong source kind", state: `{"version":1,"source_kind":"claude_main","codex":{}}`},
		{name: "unsupported version", state: `{"version":2,"source_kind":"codex_rollout","codex":{}}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			dataDir := t.TempDir()
			store, source, path, now := seedCodexIngestionSource(t, dataDir)
			line := string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
			if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
				t.Fatal(err)
			}
			if test.replaceArtifact {
				replacement := path + ".replacement"
				if err := os.WriteFile(replacement, []byte(line), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(replacement, path); err != nil {
					t.Fatal(err)
				}
			}
			writeParserStateJSON(t, dataDir, source.ID, test.state)

			ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
			result, err := ingestor.Ingest(ctx, source.ID)
			if err == nil || !strings.Contains(err.Error(), "parser state") {
				t.Fatalf("ingest error = %v, want parser state collection error", err)
			}
			if result.RetryAt == nil {
				t.Fatalf("result = %+v, want retry schedule", result)
			}
			got, ok, getErr := store.GetUsageSourceForIngestion(ctx, source.ID)
			if getErr != nil || !ok {
				t.Fatalf("get source: ok=%v err=%v", ok, getErr)
			}
			if got.Source.ByteOffset != 0 || got.Source.FailureCount != 1 ||
				got.Source.State != domain.UsageSourceError || got.Source.LastErrorCode != "invalid_parser_state" {
				t.Fatalf("source after invalid state = %+v", got.Source)
			}
			aggregates, aggregateErr := store.ListUsageModelAggregates(ctx, got.SessionID)
			if aggregateErr != nil {
				t.Fatal(aggregateErr)
			}
			if len(aggregates) != 0 {
				t.Fatalf("invalid state emitted usage: %+v", aggregates)
			}
			if persisted := readParserStateJSON(t, dataDir, source.ID); persisted != test.state {
				t.Fatalf("parser state reset to %q, want original %q", persisted, test.state)
			}
		})
	}
}

func TestIngestorReplaysReplacementWithUnknownProviderTimestampAcrossClocks(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{
			name: "missing timestamp",
			line: `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":5}}}}`,
		},
		{
			name: "invalid timestamp",
			line: `{"timestamp":"not-a-time","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":5}}}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			store, source, path, now := seedCodexIngestionSource(t, t.TempDir())
			content := test.line + "\n"
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
			if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
				t.Fatalf("initial ingest: %v", err)
			}

			replacementPath := path + ".replacement"
			if err := os.WriteFile(replacementPath, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacementPath, path); err != nil {
				t.Fatal(err)
			}
			now = now.Add(time.Hour)
			replaced, err := ingestor.Ingest(ctx, source.ID)
			if err != nil {
				t.Fatalf("replace source: %v", err)
			}
			if replaced.ReplacementSourceID == 0 {
				t.Fatalf("replacement result = %+v", replaced)
			}
			if _, err := ingestor.Ingest(ctx, replaced.ReplacementSourceID); err != nil {
				t.Fatalf("replay replacement: %v", err)
			}

			got, ok, err := store.GetUsageSourceForIngestion(ctx, replaced.ReplacementSourceID)
			if err != nil || !ok {
				t.Fatalf("get replacement: ok=%v err=%v", ok, err)
			}
			if got.Source.ByteOffset != int64(len(content)) || got.Source.LastErrorCode != "" {
				t.Fatalf("replacement source = %+v, want consumed duplicate without conflict", got.Source)
			}
			aggregates, err := store.ListUsageModelAggregates(ctx, got.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			if len(aggregates) != 1 || aggregates[0].EventCount != 1 {
				t.Fatalf("aggregates = %+v, want one replay-deduplicated event", aggregates)
			}
		})
	}
}

func TestIngestorReadsIdentityAndContentFromSingleDescriptorAcrossAtomicReplacement(t *testing.T) {
	ctx := context.Background()
	store, source, path, now := seedCodexIngestionSource(t, t.TempDir())
	openedContent := `{"type":"turn_context","payload":{"model":"gpt-opened"}}` + "\n" +
		string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
	replacementContent := `{"type":"turn_context","payload":{"model":"gpt-replacement"}}` + "\n" +
		string(codexTokenLine("2026-07-28T11:00:00Z", 200, 120, 0, 20, 5)) + "\n"
	if err := os.WriteFile(path, []byte(openedContent), 0o600); err != nil {
		t.Fatal(err)
	}
	replacementPath := path + ".replacement"
	if err := os.WriteFile(replacementPath, []byte(replacementContent), 0o600); err != nil {
		t.Fatal(err)
	}

	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	replacedPath := false
	ingestor.openTranscript = func(name string) (*os.File, error) {
		file, err := os.Open(name) //nolint:gosec // test-controlled path.
		if err == nil && !replacedPath {
			replacedPath = true
			if renameErr := os.Rename(replacementPath, path); renameErr != nil {
				_ = file.Close()
				return nil, renameErr
			}
		}
		return file, err
	}

	first, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("ingest opened generation: %v", err)
	}
	if first.ReplacementSourceID != 0 {
		t.Fatalf("opened generation was misclassified as replacement: %+v", first)
	}
	assertTokenAggregate(t, store, sourceSessionID(t, store, source.ID), 120)

	second, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("detect pathname replacement: %v", err)
	}
	if second.ReplacementSourceID == 0 {
		t.Fatalf("replacement result = %+v", second)
	}
	if _, err := ingestor.Ingest(ctx, second.ReplacementSourceID); err != nil {
		t.Fatalf("ingest replacement generation: %v", err)
	}
	assertTokenAggregate(t, store, sourceSessionID(t, store, source.ID), 340)
}

func TestIngestorReplacesSameInodeWhenPreCursorCheckpointChanges(t *testing.T) {
	tests := []struct {
		name   string
		suffix string
	}{
		{name: "equal size"},
		{name: "larger size", suffix: `{"type":"turn_context","payload":{"model":"gpt-after"}}` + "\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			store, source, path, now := seedCodexIngestionSource(t, t.TempDir())
			beforeContent := string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)) + "\n"
			afterContent := string(codexTokenLine("2026-07-28T11:00:00Z", 200, 70, 0, 30, 5)) + "\n" + test.suffix
			if test.suffix == "" && len(afterContent) != len(beforeContent) {
				t.Fatalf("equal-size fixture lengths = %d/%d", len(beforeContent), len(afterContent))
			}
			if err := os.WriteFile(path, []byte(beforeContent), 0o600); err != nil {
				t.Fatal(err)
			}
			identity, err := usagesvc.SourceIdentity(path)
			if err != nil {
				t.Fatal(err)
			}
			ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
			if _, err := ingestor.Ingest(ctx, source.ID); err != nil {
				t.Fatalf("ingest original generation: %v", err)
			}
			assertTokenAggregate(t, store, sourceSessionID(t, store, source.ID), 120)

			if err := rewriteUsageFixture(path, afterContent); err != nil {
				t.Fatal(err)
			}
			rewrittenIdentity, err := usagesvc.SourceIdentity(path)
			if err != nil {
				t.Fatal(err)
			}
			if rewrittenIdentity != identity {
				t.Fatalf("rewrite changed identity: %q != %q", rewrittenIdentity, identity)
			}

			result, err := ingestor.Ingest(ctx, source.ID)
			if err != nil {
				t.Fatalf("detect same-inode rewrite: %v", err)
			}
			if result.ReplacementSourceID == 0 {
				t.Fatalf("rewrite result = %+v, want a replacement generation", result)
			}
			replacement, ok, err := store.GetUsageSourceForIngestion(ctx, result.ReplacementSourceID)
			if err != nil || !ok {
				t.Fatalf("replacement source: ok=%v err=%v", ok, err)
			}
			if replacement.Source.Generation != source.Generation+1 || replacement.Source.ByteOffset != 0 {
				t.Fatalf("replacement source = %+v", replacement.Source)
			}
			if _, err := ingestor.Ingest(ctx, replacement.Source.ID); err != nil {
				t.Fatalf("ingest replacement generation: %v", err)
			}
			assertTokenAggregate(t, store, replacement.SessionID, 350)
		})
	}
}

func seedCodexIngestionSource(t *testing.T, dataDir string) (*sqlite.Store, domain.UsageSourceRecord, string, time.Time) {
	t.Helper()
	ctx := context.Background()
	store, err := sqlite.Open(dataDir)
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
		SessionID:      session.ID,
		Harness:        domain.HarnessCodex,
		NativeRootID:   "codex-root",
		InitialModelID: "fallback-model",
		State:          domain.UsageBindingActive,
		FirstSeenAt:    now,
		LastSeenAt:     now,
		UpdatedAt:      now,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := usagesvc.SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "codex-root",
		ArtifactPath:    path,
		FileIdentity:    identity,
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return store, source, path, now
}

func readParserStateJSON(t *testing.T, dataDir string, sourceID int64) string {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var state string
	if err := db.QueryRow("SELECT parser_state_json FROM usage_sources WHERE id = ?", sourceID).Scan(&state); err != nil {
		t.Fatalf("read parser state: %v", err)
	}
	return state
}

func writeParserStateJSON(t *testing.T, dataDir string, sourceID int64, state string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("UPDATE usage_sources SET parser_state_json = ? WHERE id = ?", state, sourceID); err != nil {
		t.Fatalf("write parser state: %v", err)
	}
}

func assertCodexParserState(t *testing.T, raw string, input int64, model, provider string) {
	t.Helper()
	var state struct {
		Version    int    `json:"version"`
		SourceKind string `json:"source_kind"`
		Codex      struct {
			Baseline struct {
				InputTokens int64 `json:"input_tokens"`
			} `json:"baseline"`
			ModelID             string   `json:"model_id"`
			Provider            string   `json:"provider"`
			PendingSpawnCallIDs []string `json:"pending_spawn_call_ids"`
			DiscoveredChildIDs  []string `json:"discovered_child_ids"`
		} `json:"codex"`
	}
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatalf("decode parser state %q: %v", raw, err)
	}
	if state.Version != 1 || state.SourceKind != "codex_rollout" ||
		state.Codex.Baseline.InputTokens != input || state.Codex.ModelID != model ||
		state.Codex.Provider != provider || state.Codex.PendingSpawnCallIDs == nil ||
		state.Codex.DiscoveredChildIDs == nil {
		t.Fatalf("Codex parser state = %+v", state)
	}
}

func sourceSessionID(t *testing.T, store *sqlite.Store, sourceID int64) domain.SessionID {
	t.Helper()
	got, ok, err := store.GetUsageSourceForIngestion(context.Background(), sourceID)
	if err != nil || !ok {
		t.Fatalf("get source context: ok=%v err=%v", ok, err)
	}
	return got.SessionID
}

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
	content := string(codexSessionMetaLine(t, "native-late", "")) + "\n" +
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
	content := string(codexSessionMetaLine(t, "native-final", "")) + "\n" +
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
	initial := string(codexSessionMetaLine(t, "native-move", "")) + "\n" +
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
	initial := string(codexSessionMetaLine(t, "native-watch", "")) + "\n" +
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
		BindingID:    binding.ID,
		Kind:         domain.UsageSourceCodexRollout,
		ArtifactPath: path,
		FileIdentity: identity,
		State:        domain.UsageSourcePending,
		CreatedAt:    now,
		UpdatedAt:    now,
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

func TestIngestorRestartsFinalTailQuiescenceWhenTailChanges(t *testing.T) {
	ctx := context.Background()
	store, source, path, now := seedCodexIngestionSource(t, t.TempDir())
	completePrefix := `{"type":"turn_context","payload":{"model":"gpt-tail"}}` + "\n"
	finalRecord := string(codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5))
	split := len(finalRecord) / 2
	if err := os.WriteFile(path, []byte(completePrefix+finalRecord[:split]), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateUsageBindingState(
		ctx,
		source.BindingID,
		domain.UsageBindingFinalizing,
		"",
		now,
	); err != nil {
		t.Fatal(err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})

	first, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("observe partial tail: %v", err)
	}
	if first.RetryAt == nil {
		t.Fatalf("first result = %+v, want quiet retry", first)
	}
	now = now.Add(defaultFinalizationWait + time.Second)
	if err := osAppend(path, finalRecord[split:]); err != nil {
		t.Fatal(err)
	}
	second, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("observe changed valid tail: %v", err)
	}
	if second.RetryAt == nil || !second.RetryAt.After(now) {
		t.Fatalf("changed-tail result = %+v, want restarted quiet retry", second)
	}
	got, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("source after changed tail: ok=%v err=%v", ok, err)
	}
	if got.Source.ByteOffset != int64(len(completePrefix)) || got.Source.State == domain.UsageSourceComplete {
		t.Fatalf("changed tail advanced source: %+v", got.Source)
	}
	assertTokenAggregate(t, store, got.SessionID, 0)

	now = now.Add(defaultFinalizationWait + time.Second)
	third, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("consume stable valid tail: %v", err)
	}
	if third.RetryAt != nil {
		t.Fatalf("stable valid tail result = %+v", third)
	}
	got, ok, err = store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("completed source: ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete || got.Source.ByteOffset != int64(len(completePrefix+finalRecord)) {
		t.Fatalf("completed source = %+v", got.Source)
	}
	assertTokenAggregate(t, store, got.SessionID, 120)
}

func TestIngestorDropsMalformedFinalTailOnlyAfterTwoQuietObservations(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, source, path, now := seedCodexIngestionSource(t, dataDir)
	completePrefix := `{"type":"turn_context","payload":{"model":"gpt-tail"}}` + "\n"
	malformedTail := `{"type":"event_msg","payload":`
	if err := os.WriteFile(path, []byte(completePrefix+malformedTail), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateUsageBindingState(
		ctx,
		source.BindingID,
		domain.UsageBindingFinalizing,
		"",
		now,
	); err != nil {
		t.Fatal(err)
	}
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})

	first, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("observe malformed tail: %v", err)
	}
	if first.RetryAt == nil {
		t.Fatalf("first result = %+v, want quiet retry", first)
	}
	persistedState := readParserStateJSON(t, dataDir, source.ID)
	if strings.Contains(persistedState, malformedTail) {
		t.Fatalf("parser state persisted transcript tail: %s", persistedState)
	}
	now = now.Add(defaultFinalizationWait + time.Second)
	second, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("first quiet observation: %v", err)
	}
	if second.RetryAt == nil || !second.RetryAt.After(now) {
		t.Fatalf("first quiet result = %+v, want additional quiet retry", second)
	}
	got, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("pending source: ok=%v err=%v", ok, err)
	}
	if got.Source.ByteOffset != int64(len(completePrefix)) || got.Source.AnomalyCount != 0 ||
		got.Source.State == domain.UsageSourceComplete {
		t.Fatalf("malformed tail consumed too early: %+v", got.Source)
	}

	now = now.Add(defaultFinalizationWait + time.Second)
	third, err := ingestor.Ingest(ctx, source.ID)
	if err != nil {
		t.Fatalf("second quiet observation: %v", err)
	}
	if third.RetryAt != nil {
		t.Fatalf("second quiet result = %+v", third)
	}
	got, ok, err = store.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("completed source: ok=%v err=%v", ok, err)
	}
	if got.Source.State != domain.UsageSourceComplete ||
		got.Source.ByteOffset != int64(len(completePrefix+malformedTail)) ||
		got.Source.AnomalyCount != 1 || got.Source.LastErrorCode != domain.UsageErrorMalformedJSONL {
		t.Fatalf("completed malformed source = %+v", got.Source)
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
		BindingID:    binding.ID,
		Kind:         domain.UsageSourceCodexRollout,
		ArtifactPath: path,
		FileIdentity: identity,
		State:        domain.UsageSourcePending,
		CreatedAt:    now,
		UpdatedAt:    now,
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
	if parsed.err != nil {
		t.Fatal(parsed.err)
	}
	conflict := parsed.Events[0]
	conflict.Tokens.OutputTokens++
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

func rewriteUsageFixture(path, content string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
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
