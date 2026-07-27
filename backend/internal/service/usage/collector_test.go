package usage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestCollectorRegistersFinalizesAndReactivatesSource(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-1", false)
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "07", "27", "rollout-native-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{\"type\":\"session_meta\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wakes := 0
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, func() { wakes++ })
	now := time.Unix(1700000000, 0).UTC()
	collector.now = func() time.Time { return now }

	err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Harness:         domain.HarnessCodex,
		Event:           "session-start",
		NativeSessionID: "native-1",
		TranscriptPath:  path,
		ModelID:         "gpt-5.6",
	})
	if err != nil {
		t.Fatalf("record start: %v", err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	if bindings[0].State != domain.UsageBindingActive || sources[0].State != domain.UsageSourceActive ||
		sources[0].CurrentModelID != "gpt-5.6" || wakes == 0 {
		t.Fatalf("registered binding=%+v source=%+v wakes=%d", bindings[0], sources[0], wakes)
	}

	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{Event: "process-exited"}); err != nil {
		t.Fatalf("finalize: %v", err)
	}
	bindings, _ = store.ListUsageBindingsForSession(context.Background(), session.ID)
	if bindings[0].State != domain.UsageBindingFinalizing {
		t.Fatalf("finalized binding state = %s", bindings[0].State)
	}

	if _, err := store.MarkUsageSourceState(context.Background(), sources[0].ID, domain.UsageSourceComplete, "", nil, now); err != nil {
		t.Fatal(err)
	}
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Harness:         domain.HarnessCodex,
		Event:           "session-start",
		NativeSessionID: "native-1",
		TranscriptPath:  path,
	}); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	sources, _ = store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if sources[0].State != domain.UsageSourceActive {
		t.Fatalf("reactivated source state = %s", sources[0].State)
	}
}

func TestCollectorRejectsPathOutsideProviderRootAndSymlinkEscape(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-1", false)
	base := t.TempDir()
	root := filepath.Join(base, "projects")
	outside := filepath.Join(base, "outside.jsonl")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
	signal := HookSignal{
		Harness:         domain.HarnessClaudeCode,
		Event:           "session-start",
		NativeSessionID: "claude-1",
		TranscriptPath:  outside,
	}
	if err := collector.RecordHook(context.Background(), session.ID, signal); err == nil {
		t.Fatal("outside path accepted")
	}

	link := filepath.Join(root, "escape.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	signal.TranscriptPath = link
	if err := collector.RecordHook(context.Background(), session.ID, signal); err == nil {
		t.Fatal("symlink escape accepted")
	}
}

func TestCollectorBackfillsOnlyNonTerminatedSupportedSessions(t *testing.T) {
	store := collectorTestStore(t)
	active := collectorTestSession(t, store, domain.HarnessClaudeCode, "active-native", false)
	_ = collectorTestSession(t, store, domain.HarnessClaudeCode, "terminated-native", true)
	_ = collectorTestSession(t, store, domain.HarnessAider, "unsupported-native", false)
	root := filepath.Join(t.TempDir(), "projects")
	path := filepath.Join(root, "workspace", "active-native.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), active.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("active bindings=%+v err=%v", bindings, err)
	}
	counts, err := store.CountUsageRowsForSession(context.Background(), active.ID)
	if err != nil || counts.SourceCount != 1 {
		t.Fatalf("active counts=%+v err=%v", counts, err)
	}
}

func collectorTestStore(t *testing.T) *sqlite.Store {
	t.Helper()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.UpsertProject(context.Background(), domain.ProjectRecord{
		ID:           "usage-test",
		Path:         t.TempDir(),
		RegisteredAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	return store
}

func collectorTestSession(t *testing.T, store *sqlite.Store, harness domain.AgentHarness, nativeID string, terminated bool) domain.SessionRecord {
	t.Helper()
	now := time.Now().UTC()
	session, err := store.CreateSession(context.Background(), domain.SessionRecord{
		ProjectID:    "usage-test",
		Kind:         domain.KindWorker,
		Harness:      harness,
		Activity:     domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		IsTerminated: terminated,
		Metadata: domain.SessionMetadata{
			AgentSessionID: nativeID,
		},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}
