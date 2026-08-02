package usage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, func(bool) { wakes++ })
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
	if bindings[0].State != domain.UsageBindingActive || bindings[0].InitialModelID != "gpt-5.6" ||
		sources[0].State != domain.UsageSourceActive || wakes == 0 {
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

func TestCollectorSerializesFinalizationAgainstEarlierHook(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-serialized", false)
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "rollout-native-serialized.jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, "native-serialized", ""))

	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	now := time.Unix(1700000000, 0).UTC()
	entered := make(chan struct{})
	release := make(chan struct{})
	var first sync.Once
	collector.now = func() time.Time {
		block := false
		first.Do(func() {
			block = true
			close(entered)
		})
		if block {
			<-release
		}
		return now
	}

	ordinaryDone := make(chan error, 1)
	go func() {
		ordinaryDone <- collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:           "notification",
			NativeSessionID: "native-serialized",
			TranscriptPath:  path,
		})
	}()
	<-entered

	finalDone := make(chan error, 1)
	go func() {
		finalDone <- collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:           "process-exited",
			NativeSessionID: "native-serialized",
			TranscriptPath:  path,
		})
	}()
	close(release)
	if err := <-ordinaryDone; err != nil {
		t.Fatalf("ordinary hook: %v", err)
	}
	if err := <-finalDone; err != nil {
		t.Fatalf("final hook: %v", err)
	}

	binding, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, "native-serialized")
	if err != nil || !ok {
		t.Fatalf("binding ok=%v err=%v", ok, err)
	}
	if binding.State != domain.UsageBindingFinalizing {
		t.Fatalf("binding state=%s, want finalizing", binding.State)
	}
}

func TestCollectorIgnoresUsageSignalFromStaleRuntimeLaunch(t *testing.T) {
	store := collectorTestStore(t)
	now := time.Now().UTC()
	session, err := store.CreateSession(context.Background(), domain.SessionRecord{
		ProjectID: "usage-test",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		Metadata: domain.SessionMetadata{
			AgentSessionID:  "native-fenced",
			RuntimeLaunchID: "launch-current",
		},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "07", "28", "rollout-native-fenced.jsonl")
	writeUsageFixture(t, path, "{\"type\":\"session_meta\"}\n")
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Harness:         domain.HarnessCodex,
		Event:           "session-start",
		LaunchID:        "launch-current",
		NativeSessionID: "native-fenced",
		TranscriptPath:  path,
	}); err != nil {
		t.Fatal(err)
	}
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:    "process-exited",
		LaunchID: "launch-old",
	}); err != nil {
		t.Fatal(err)
	}

	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	if bindings[0].State != domain.UsageBindingActive {
		t.Fatalf("stale launch finalized usage binding: %+v", bindings[0])
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
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("active sources=%+v err=%v", sources, err)
	}
}

func TestCollectorReconcilesCodexSourceCreatedAfterDaemonStart(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-late", false)
	root := filepath.Join(t.TempDir(), "sessions")
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("initial backfill: %v", err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingDiscovering {
		t.Fatalf("initial bindings=%+v err=%v", bindings, err)
	}

	path := filepath.Join(root, "2026", "07", "28", "rollout-native-late.jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, "native-late", ""))
	if err := collector.ReconcileSources(context.Background(), 8); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	bindings, _ = store.ListUsageBindingsForSession(context.Background(), session.ID)
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	if bindings[0].State != domain.UsageBindingActive || sources[0].ArtifactPath != resolvedPath {
		t.Fatalf("binding/source=%+v/%+v", bindings[0], sources[0])
	}
}

func TestCollectorDiscoversFinalizingCodexSourceAndArchivedRelocation(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSessionWithActivity(t, store, domain.HarnessCodex, "native-exit", false, domain.ActivityExited)
	sessionsRoot := filepath.Join(t.TempDir(), "sessions")
	archiveRoot := filepath.Join(t.TempDir(), "archived_sessions")
	collector := NewCollector(store, SourceRoots{CodexSessions: sessionsRoot, CodexArchived: archiveRoot}, nil)

	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill finalizing: %v", err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingFinalizing {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}

	activePath := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-native-exit.jsonl")
	writeUsageFixture(t, activePath, codexSessionMetaFixture(t, "native-exit", ""))
	if err := collector.ReconcileSources(context.Background(), 8); err != nil {
		t.Fatalf("discover active path: %v", err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("active sources=%+v err=%v", sources, err)
	}

	archivedPath := filepath.Join(archiveRoot, filepath.Base(activePath))
	if err := os.MkdirAll(filepath.Dir(archivedPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(activePath, archivedPath); err != nil {
		t.Fatal(err)
	}
	if err := collector.ReconcileSources(context.Background(), 8); err != nil {
		t.Fatalf("discover archived path: %v", err)
	}
	sources, err = store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 2 {
		t.Fatalf("relocated sources=%+v err=%v", sources, err)
	}
	resolvedArchivedPath, err := filepath.EvalSymlinks(archivedPath)
	if err != nil {
		t.Fatal(err)
	}
	if sources[0].State != domain.UsageSourceComplete || sources[1].ArtifactPath != resolvedArchivedPath ||
		sources[1].ByteOffset != sources[0].ByteOffset {
		t.Fatalf("relocated sources=%+v", sources)
	}
}

func TestCollectorBackfillPreservesCompletedExitedBinding(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSessionWithActivity(t, store, domain.HarnessCodex, "native-complete", false, domain.ActivityExited)
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "07", "28", "rollout-native-complete.jsonl")
	writeUsageFixture(t, path, `{"type":"session_meta"}`+"\n")
	now := time.Now().UTC()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "native-complete",
		State:        domain.UsageBindingComplete,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:    binding.ID,
		Kind:         domain.UsageSourceCodexRollout,
		ArtifactPath: path,
		FileIdentity: identity,
		State:        domain.UsageSourceComplete,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	gotBinding, _, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, "native-complete")
	if err != nil {
		t.Fatal(err)
	}
	gotSource, ok, err := store.GetUsageSourceForIngestion(context.Background(), source.ID)
	if err != nil || !ok {
		t.Fatalf("source ok=%v err=%v", ok, err)
	}
	if gotBinding.State != domain.UsageBindingComplete || gotSource.Source.State != domain.UsageSourceComplete {
		t.Fatalf("backfill reopened completed usage: binding=%s source=%s", gotBinding.State, gotSource.Source.State)
	}
}

func TestCollectorBackfillDiscoversClaudeSubagentSources(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-root", false)
	root := filepath.Join(t.TempDir(), "projects")
	mainPath := filepath.Join(root, "workspace", "claude-root.jsonl")
	subagentPath := filepath.Join(root, "workspace", "claude-root", "subagents", "agent-sub-7.jsonl")
	writeUsageFixture(t, mainPath, `{"type":"assistant"}`+"\n")
	writeUsageFixture(t, subagentPath, `{"type":"assistant"}`+"\n")

	collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	bindings, _ := store.ListUsageBindingsForSession(context.Background(), session.ID)
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	if sources[0].Kind != domain.UsageSourceClaudeMain ||
		sources[1].Kind != domain.UsageSourceClaudeSubagent ||
		sources[1].SubagentID != "sub-7" {
		t.Fatalf("sources=%+v", sources)
	}
}

func TestCollectorSubagentStopReactivatesCompletedSource(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-late", false)
	root := filepath.Join(t.TempDir(), "projects")
	subagentPath := filepath.Join(root, "workspace", "claude-late", "subagents", "agent-sub-late.jsonl")
	initial := []byte(`{"type":"assistant"}` + "\n")
	writeUsageFixture(t, subagentPath, string(initial))
	now := time.Now().UTC()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "claude-late",
		State:        domain.UsageBindingComplete,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := SourceIdentity(subagentPath)
	if err != nil {
		t.Fatal(err)
	}
	resolvedSubagentPath, err := filepath.EvalSymlinks(subagentPath)
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeSubagent,
		NativeSessionID: "claude-late",
		SubagentID:      "sub-late",
		ArtifactPath:    resolvedSubagentPath,
		FileIdentity:    identity,
		ByteOffset:      int64(len(initial)),
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(subagentPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"type":"assistant","late":true}` + "\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:                  "subagent-stop",
		NativeSessionID:        "claude-late",
		SubagentID:             "sub-late",
		SubagentTranscriptPath: subagentPath,
	}); err != nil {
		t.Fatalf("record subagent stop: %v", err)
	}

	gotBinding, _, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, "claude-late")
	if err != nil {
		t.Fatal(err)
	}
	gotSource, ok, err := store.GetUsageSourceForIngestion(context.Background(), source.ID)
	if err != nil || !ok {
		t.Fatalf("source ok=%v err=%v", ok, err)
	}
	if gotBinding.State != domain.UsageBindingFinalizing || gotSource.Source.State != domain.UsageSourceActive {
		t.Fatalf("binding/source states=%s/%s", gotBinding.State, gotSource.Source.State)
	}
}

func TestDiscoverClaudeSubagentPathsReturnsAllSources(t *testing.T) {
	root := t.TempDir()
	mainPath := filepath.Join(root, "claude-many.jsonl")
	writeUsageFixture(t, mainPath, "{}\n")
	for index := 0; index < 129; index++ {
		path := filepath.Join(root, "claude-many", "subagents", fmt.Sprintf("agent-%03d.jsonl", index))
		writeUsageFixture(t, path, "{}\n")
	}

	paths := discoverClaudeSubagentPaths(mainPath)
	if len(paths) != 129 {
		t.Fatalf("discovered %d subagent paths, want 129", len(paths))
	}
}

func TestCollectorDiscoveryLimitRotatesPendingBindings(t *testing.T) {
	store := collectorTestStore(t)
	first := collectorTestSession(t, store, domain.HarnessCodex, "native-first", false)
	second := collectorTestSession(t, store, domain.HarnessCodex, "native-second", false)
	root := filepath.Join(t.TempDir(), "sessions")
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	now := time.Unix(1700000000, 0).UTC()
	collector.now = func() time.Time {
		now = now.Add(time.Second)
		return now
	}
	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	secondPath := filepath.Join(root, "2026", "07", "28", "rollout-native-second.jsonl")
	writeUsageFixture(t, secondPath, codexSessionMetaFixture(t, "native-second", ""))
	if err := collector.ReconcileSources(context.Background(), 1); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	if err := collector.ReconcileSources(context.Background(), 1); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	firstBindings, _ := store.ListUsageBindingsForSession(context.Background(), first.ID)
	secondBindings, _ := store.ListUsageBindingsForSession(context.Background(), second.ID)
	firstSources, _ := store.ListUsageSourcesForBinding(context.Background(), firstBindings[0].ID)
	secondSources, _ := store.ListUsageSourcesForBinding(context.Background(), secondBindings[0].ID)
	if len(firstSources) != 0 || len(secondSources) != 1 {
		t.Fatalf("first/second sources=%+v/%+v", firstSources, secondSources)
	}
}

func TestCollectorResumeReactivatesAllLatestCodexSources(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-resume", false)
	now := time.Now().UTC()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "native-resume",
		State:        domain.UsageBindingComplete,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	oldSource, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "native-resume",
		ArtifactPath:    "/tmp/usage-parent.jsonl",
		FileIdentity:    "parent-old",
		Generation:      0,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	latestSource, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "native-resume",
		ArtifactPath:    "/tmp/usage-parent.jsonl",
		FileIdentity:    "parent-latest",
		Generation:      1,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	const childID = "22222222-2222-4222-8222-222222222222"
	childSource, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: childID,
		SubagentID:      childID,
		ArtifactPath:    "/tmp/usage-child.jsonl",
		FileIdentity:    "child",
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "session-start",
		NativeSessionID: "native-resume",
	}); err != nil {
		t.Fatalf("resume: %v", err)
	}
	oldContext, _, _ := store.GetUsageSourceForIngestion(context.Background(), oldSource.ID)
	latestContext, _, _ := store.GetUsageSourceForIngestion(context.Background(), latestSource.ID)
	childContext, _, _ := store.GetUsageSourceForIngestion(context.Background(), childSource.ID)
	if oldContext.Source.State != domain.UsageSourceComplete ||
		latestContext.Source.State != domain.UsageSourceActive ||
		childContext.Source.State != domain.UsageSourceActive {
		t.Fatalf("old/latest/child states=%s/%s/%s", oldContext.Source.State, latestContext.Source.State, childContext.Source.State)
	}
}

func TestCollectorReconcilesPersistedCodexChildrenRecursively(t *testing.T) {
	store := collectorTestStore(t)
	const (
		rootID       = "11111111-1111-4111-8111-111111111111"
		childID      = "22222222-2222-4222-8222-222222222222"
		grandchildID = "33333333-3333-4333-8333-333333333333"
		wrongID      = "44444444-4444-4444-8444-444444444444"
	)
	session := collectorTestSession(t, store, domain.HarnessCodex, rootID, false)
	base := t.TempDir()
	sessionsRoot := filepath.Join(base, "sessions")
	archiveRoot := filepath.Join(base, "archived_sessions")
	rootPath := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-"+rootID+".jsonl")
	childPath := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-"+childID+".jsonl")
	wrongPath := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-"+wrongID+".jsonl")
	grandchildPath := filepath.Join(archiveRoot, "rollout-"+grandchildID+".jsonl")
	writeUsageFixture(t, rootPath, codexSessionMetaFixture(t, rootID, ""))
	writeUsageFixture(t, childPath, codexSessionMetaFixture(t, childID, rootID))
	writeUsageFixture(t, wrongPath, codexSessionMetaFixture(t, wrongID, "not-the-root"))
	writeUsageFixture(t, grandchildPath, codexSessionMetaFixture(t, grandchildID, childID))

	collector := NewCollector(store, SourceRoots{CodexSessions: sessionsRoot, CodexArchived: archiveRoot}, nil)
	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill root: %v", err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("root sources=%+v err=%v", sources, err)
	}
	parentState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + childID + `","` + childID + `","` + wrongID + `"]}}`
	if _, err := store.ApplyUsageChunk(context.Background(), sources[0].ID, 0, domain.SourceCursorState{
		State:           domain.UsageSourceActive,
		ParserStateJSON: parentState,
		UpdatedAt:       time.Now().UTC(),
	}, nil); err != nil {
		t.Fatal(err)
	}

	restarted := NewCollector(store, SourceRoots{CodexSessions: sessionsRoot, CodexArchived: archiveRoot}, nil)
	if err := restarted.ReconcileSources(context.Background(), -1); err != nil {
		t.Fatalf("reconcile persisted child: %v", err)
	}
	sources, err = store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources after child reconcile=%+v err=%v", sources, err)
	}
	var rootSource, childSource domain.UsageSourceRecord
	for _, source := range sources {
		switch source.NativeSessionID {
		case rootID:
			rootSource = source
		case childID:
			childSource = source
		}
	}
	if rootSource.ID == 0 || childSource.ID == 0 || childSource.SubagentID != childID ||
		rootSource.State == domain.UsageSourceComplete {
		t.Fatalf("parent/child sources=%+v", sources)
	}

	childState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + grandchildID + `"]}}`
	if _, err := store.ApplyUsageChunk(context.Background(), childSource.ID, 0, domain.SourceCursorState{
		State:           domain.UsageSourceActive,
		ParserStateJSON: childState,
		UpdatedAt:       time.Now().UTC(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := restarted.ReconcileSources(context.Background(), -1); err != nil {
		t.Fatalf("reconcile persisted grandchild: %v", err)
	}
	sources, err = store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 3 {
		t.Fatalf("recursive sources=%+v err=%v", sources, err)
	}
	foundGrandchild := false
	for _, source := range sources {
		if source.NativeSessionID == wrongID {
			t.Fatalf("registered child whose session parent was wrong: %+v", source)
		}
		if source.NativeSessionID == grandchildID {
			foundGrandchild = source.SubagentID == grandchildID && source.ArtifactPath == canonicalUsagePath(t, grandchildPath)
		}
	}
	if !foundGrandchild {
		t.Fatalf("archived grandchild missing from sources=%+v", sources)
	}
}

func TestCollectorResumeKeepsDiscoveringAfterOnlyArchivedRolloutMatches(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-resume-late", false)
	sessionsRoot := filepath.Join(t.TempDir(), "sessions")
	archiveRoot := filepath.Join(t.TempDir(), "archived_sessions")
	archivedPath := filepath.Join(archiveRoot, "rollout-native-resume-late.jsonl")
	content := codexSessionMetaFixture(t, "native-resume-late", "")
	writeUsageFixture(t, archivedPath, content)
	now := time.Now().UTC()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "native-resume-late",
		State:        domain.UsageBindingComplete,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := SourceIdentity(archivedPath)
	if err != nil {
		t.Fatal(err)
	}
	resolvedArchivedPath, err := filepath.EvalSymlinks(archivedPath)
	if err != nil {
		t.Fatal(err)
	}
	archivedSource, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "native-resume-late",
		ArtifactPath:    resolvedArchivedPath,
		FileIdentity:    identity,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	collector := NewCollector(store, SourceRoots{CodexSessions: sessionsRoot, CodexArchived: archiveRoot}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "session-start",
		NativeSessionID: "native-resume-late",
	}); err != nil {
		t.Fatalf("resume start: %v", err)
	}
	resumedBinding, _, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, "native-resume-late")
	if err != nil {
		t.Fatal(err)
	}
	if resumedBinding.State != domain.UsageBindingActive ||
		resumedBinding.LastErrorCode != domain.UsageErrorSourceDiscoveryPending {
		t.Fatalf("resumed binding=%+v", resumedBinding)
	}

	activePath := filepath.Join(sessionsRoot, "2026", "07", "28", "rollout-native-resume-late.jsonl")
	writeUsageFixture(t, activePath, content)
	if err := collector.ReconcileSources(context.Background(), 8); err != nil {
		t.Fatalf("reconcile active rollout: %v", err)
	}
	resumedBinding, _, _ = store.GetUsageBinding(context.Background(), session.ID, session.Harness, "native-resume-late")
	sources, err := store.ListUsageSourcesForBinding(context.Background(), binding.ID)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	oldContext, _, _ := store.GetUsageSourceForIngestion(context.Background(), archivedSource.ID)
	if resumedBinding.LastErrorCode != "" || oldContext.Source.State != domain.UsageSourceComplete {
		t.Fatalf("binding/old source=%+v/%+v", resumedBinding, oldContext.Source)
	}
}

func TestCollectorDoesNotTransferCursorAcrossNativeSessions(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "root-native", false)
	now := time.Unix(1700000000, 0).UTC()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "root-native",
		State:        domain.UsageBindingActive,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	firstPath := filepath.Join(root, "first.jsonl")
	secondPath := filepath.Join(root, "second.jsonl")
	if err := os.WriteFile(firstPath, []byte(strings.Repeat("x", 256)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(firstPath, secondPath); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	if _, err := collector.registerSource(
		context.Background(),
		binding,
		domain.UsageSourceCodexRollout,
		"native-a",
		"",
		firstPath,
		now,
		false,
	); err != nil {
		t.Fatal(err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), binding.ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	if _, err := store.ApplyUsageChunk(context.Background(), sources[0].ID, 0, domain.SourceCursorState{
		ByteOffset: 100,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.registerSource(
		context.Background(),
		binding,
		domain.UsageSourceCodexRollout,
		"native-b",
		"",
		secondPath,
		now.Add(time.Second),
		false,
	); err != nil {
		t.Fatal(err)
	}
	sources, err = store.ListUsageSourcesForBinding(context.Background(), binding.ID)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	if sources[1].NativeSessionID != "native-b" || sources[1].ByteOffset != 0 {
		t.Fatalf("new native source inherited an unrelated cursor: %+v", sources[1])
	}
}

func TestCollectorFinalizationReactivatesOnlyLatestCodexGenerationPerNativeSession(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-relocated", false)
	now := time.Now().UTC()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:    session.ID,
		Harness:      session.Harness,
		NativeRootID: "native-relocated",
		State:        domain.UsageBindingComplete,
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	oldSource, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "native-relocated",
		ArtifactPath:    "/tmp/codex/sessions/rollout-native-relocated.jsonl",
		FileIdentity:    "same-inode",
		Generation:      0,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	latestSource, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "native-relocated",
		ArtifactPath:    "/tmp/codex/archived_sessions/rollout-native-relocated.jsonl",
		FileIdentity:    "same-inode",
		Generation:      1,
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.FinalizeSession(context.Background(), session.ID); err != nil {
		t.Fatalf("finalize relocated rollout: %v", err)
	}
	oldContext, _, _ := store.GetUsageSourceForIngestion(context.Background(), oldSource.ID)
	latestContext, _, _ := store.GetUsageSourceForIngestion(context.Background(), latestSource.ID)
	if oldContext.Source.State != domain.UsageSourceComplete || latestContext.Source.State != domain.UsageSourceActive {
		t.Fatalf("old/latest relocated states = %s/%s", oldContext.Source.State, latestContext.Source.State)
	}
}

func TestCodexSessionMetaMatchesLargeRollout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-large.jsonl")
	content := codexSessionMetaFixture(t, "native-large", "") + strings.Repeat(`{"type":"event_msg"}`+"\n", 5000)
	writeUsageFixture(t, path, content)
	if !codexSessionMetaMatches(path, "native-large", "") {
		t.Fatal("valid first session_meta record was rejected because later rollout content exceeded the read bound")
	}
}

func TestDiscoverCodexPathRequiresConfiguredRoots(t *testing.T) {
	const nativeID = "11111111-1111-4111-8111-111111111111"
	t.Chdir(t.TempDir())
	path := filepath.Join("2026", "07", "28", "rollout-"+nativeID+".jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, nativeID, ""))

	collector := NewCollector(collectorTestStore(t), SourceRoots{}, nil)
	if got := collector.discoverCodexPath(nativeID, ""); got != "" {
		t.Fatalf("unconfigured Codex roots discovered %q", got)
	}
}

func TestSourceIdentityChangesWhenFileIsReplacedWithSameFirstRecord(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	previous := filepath.Join(root, "previous.jsonl")
	content := []byte(`{"type":"session_meta","payload":{"id":"same"}}` + "\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, previous); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("replacement identity = %q, want a new file generation", second)
	}
}

func TestSourceIdentityDoesNotChangeAsFirstRecordIsWritten(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	emptyIdentity, err := SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"type":"session_meta"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writtenIdentity, err := SourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if emptyIdentity != writtenIdentity {
		t.Fatalf("identity changed while first record was written: %q != %q", emptyIdentity, writtenIdentity)
	}
}

func TestValidateSourcePathRedactsArtifactPath(t *testing.T) {
	allowedRoot := t.TempDir()
	secretRoot := t.TempDir()
	secretPath := filepath.Join(secretRoot, "private-session.jsonl")
	writeUsageFixture(t, secretPath, `{"type":"session_meta"}`+"\n")
	collector := NewCollector(nil, SourceRoots{CodexSessions: allowedRoot}, nil)

	_, _, _, err := collector.validateSourcePath(domain.HarnessCodex, secretPath)
	if err == nil {
		t.Fatal("expected path outside provider root to be rejected")
	}
	if strings.Contains(err.Error(), secretPath) {
		t.Fatalf("validation error exposed artifact path: %v", err)
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
	return collectorTestSessionWithActivity(t, store, harness, nativeID, terminated, domain.ActivityIdle)
}

func collectorTestSessionWithActivity(
	t *testing.T,
	store *sqlite.Store,
	harness domain.AgentHarness,
	nativeID string,
	terminated bool,
	activity domain.ActivityState,
) domain.SessionRecord {
	t.Helper()
	now := time.Now().UTC()
	session, err := store.CreateSession(context.Background(), domain.SessionRecord{
		ProjectID:    "usage-test",
		Kind:         domain.KindWorker,
		Harness:      harness,
		Activity:     domain.Activity{State: activity, LastActivityAt: now},
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

func writeUsageFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func codexSessionMetaFixture(t *testing.T, id, parentID string) string {
	t.Helper()
	payload := map[string]any{"id": id, "model_provider": "openai"}
	if parentID != "" {
		payload["source"] = map[string]any{
			"subagent": map[string]any{
				"thread_spawn": map[string]any{"parent_thread_id": parentID},
			},
		}
	}
	line, err := json.Marshal(map[string]any{"type": "session_meta", "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	return string(line) + "\n"
}

func canonicalUsagePath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}
