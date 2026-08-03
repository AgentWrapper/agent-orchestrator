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
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
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
	if err := os.WriteFile(path, []byte(codexSessionMetaFixture(t, "native-1", "")), 0o600); err != nil {
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

type delayedFinalizeStore struct {
	collectorStore
	entered chan<- struct{}
	release <-chan struct{}
}

func (s *delayedFinalizeStore) FinalizeUsageBindingsForSessionLaunch(
	ctx context.Context,
	sessionID domain.SessionID,
	expectedLaunchID string,
	expectedSessionRevision time.Time,
	at time.Time,
) ([]domain.UsageBindingRecord, error) {
	close(s.entered)
	<-s.release
	return s.collectorStore.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sessionID,
		expectedLaunchID,
		expectedSessionRevision,
		at,
	)
}

type blockedAfterFinalizeStore struct {
	collectorStore
	finalized chan<- struct{}
	release   <-chan struct{}
}

func (s *blockedAfterFinalizeStore) FinalizeUsageBindingsForSessionLaunch(
	ctx context.Context,
	sessionID domain.SessionID,
	expectedLaunchID string,
	expectedSessionRevision time.Time,
	at time.Time,
) ([]domain.UsageBindingRecord, error) {
	bindings, err := s.collectorStore.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sessionID,
		expectedLaunchID,
		expectedSessionRevision,
		at,
	)
	if err != nil {
		return nil, err
	}
	close(s.finalized)
	<-s.release
	return bindings, nil
}

type blockedBeforeCollectorFinalizer struct {
	collector *Collector
	entered   chan<- struct{}
	release   <-chan struct{}
}

func (f *blockedBeforeCollectorFinalizer) FinalizeSession(
	ctx context.Context,
	sessionID domain.SessionID,
	expectedLaunchID string,
	expectedSessionRevision time.Time,
) error {
	close(f.entered)
	<-f.release
	return f.collector.FinalizeSession(ctx, sessionID, expectedLaunchID, expectedSessionRevision)
}

func TestCollectorFinalizationSkipsRelaunchCommittedBeforeStorageFence(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-relaunched", false)
	session.Metadata.RuntimeLaunchID = "launch-old"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0).UTC()
	binding := seedCollectorUsageBinding(t, store, session, "native-relaunched", domain.UsageBindingActive, now, "")
	entered := make(chan struct{})
	release := make(chan struct{})
	collector := NewCollector(&delayedFinalizeStore{
		collectorStore: store,
		entered:        entered,
		release:        release,
	}, SourceRoots{}, nil)

	done := make(chan error, 1)
	go func() {
		done <- collector.FinalizeSession(context.Background(), session.ID, "launch-old", session.UpdatedAt)
	}()
	<-entered
	session.Metadata.RuntimeLaunchID = "launch-new"
	session.UpdatedAt = now.Add(time.Second)
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding ok=%v err=%v", ok, err)
	}
	if got.State != domain.UsageBindingActive {
		t.Fatalf("stale finalizer changed live binding state to %s", got.State)
	}
}

func TestCollectorFinalizationSkipsActivityCommittedBeforeStorageFence(t *testing.T) {
	store := collectorTestStore(t)
	now := time.Now().UTC()
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "native-before-fence", false)
	session.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-2 * time.Minute)}
	session.Metadata.RuntimeLaunchID = "launch-current"
	session.UpdatedAt = now.Add(-2 * time.Minute)
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	binding := seedCollectorUsageBinding(
		t, store, session, "native-before-fence", domain.UsageBindingActive, session.UpdatedAt, "",
	)

	collector := NewCollector(store, SourceRoots{}, nil)
	entered := make(chan struct{})
	release := make(chan struct{})
	manager := lifecycle.New(store, nil)
	manager.SetUsageFinalizer(&blockedBeforeCollectorFinalizer{
		collector: collector,
		entered:   entered,
		release:   release,
	})

	reaperDone := make(chan error, 1)
	go func() {
		reaperDone <- manager.ApplyRuntimeObservation(context.Background(), session.ID, ports.RuntimeFacts{
			ObservedAt: now,
			Runtime:    ports.ProbeDead,
			LaunchID:   "launch-current",
		})
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("reaper did not reach usage finalizer")
	}

	if err := manager.ApplyActivitySignal(context.Background(), session.ID, ports.ActivitySignal{
		Valid:          true,
		State:          domain.ActivityActive,
		Timestamp:      now.Add(time.Second),
		Event:          "post-tool-use",
		AgentSessionID: "native-before-fence",
		LaunchID:       "launch-current",
	}); err != nil {
		t.Fatal(err)
	}
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "post-tool-use",
		LaunchID:        "launch-current",
		NativeSessionID: "native-before-fence",
	}); err != nil {
		t.Fatal(err)
	}
	committedSession, ok, err := store.GetSession(context.Background(), session.ID)
	if err != nil || !ok {
		t.Fatalf("session before finalizer ok=%v err=%v", ok, err)
	}
	committedBinding, ok, err := store.GetUsageBinding(
		context.Background(),
		session.ID,
		session.Harness,
		binding.NativeRootID,
	)
	if err != nil || !ok {
		t.Fatalf("binding before finalizer ok=%v err=%v", ok, err)
	}
	if committedSession.UpdatedAt.Equal(session.UpdatedAt) ||
		!committedBinding.UpdatedAt.After(binding.UpdatedAt) ||
		committedBinding.State != domain.UsageBindingActive {
		t.Fatalf("activity/usage did not commit before finalizer: session=%+v binding=%+v", committedSession, committedBinding)
	}

	close(release)
	select {
	case err := <-reaperDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reaper did not finish after finalizer release")
	}
	gotSession, ok, err := store.GetSession(context.Background(), session.ID)
	if err != nil || !ok {
		t.Fatalf("session after finalizer ok=%v err=%v", ok, err)
	}
	gotBinding, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding after finalizer ok=%v err=%v", ok, err)
	}
	if gotSession.IsTerminated || gotBinding.State != domain.UsageBindingActive {
		t.Fatalf("pre-finalizer activity lost: terminated=%v binding=%s", gotSession.IsTerminated, gotBinding.State)
	}
}

func TestCollectorSessionStartReactivatesAfterOldGenerationFinalization(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "native-reactivated", false)
	session.Metadata.RuntimeLaunchID = "launch-old"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "rollout-native-reactivated.jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, "native-reactivated", ""))
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "session-start",
		LaunchID:        "launch-old",
		NativeSessionID: "native-reactivated",
		TranscriptPath:  path,
	}); err != nil {
		t.Fatal(err)
	}
	if err := collector.FinalizeSession(context.Background(), session.ID, "launch-old", session.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingFinalizing {
		t.Fatalf("finalized bindings=%+v err=%v", bindings, err)
	}

	session.Metadata.RuntimeLaunchID = "launch-new"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "session-start",
		LaunchID:        "launch-new",
		NativeSessionID: "native-reactivated",
		TranscriptPath:  path,
	}); err != nil {
		t.Fatal(err)
	}
	bindings, err = store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingActive {
		t.Fatalf("reactivated bindings=%+v err=%v", bindings, err)
	}
}

func TestCollectorCurrentLaunchActivityReactivatesFinalizingBindingAndSources(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "native-current", false)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	binding := seedCollectorUsageBinding(t, store, session, "native-current", domain.UsageBindingFinalizing, now, "")
	source, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "native-current",
		ArtifactPath:    "/tmp/native-current.jsonl",
		FileIdentity:    "native-current",
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "post-tool-use",
		LaunchID:        "launch-current",
		NativeSessionID: "native-current",
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding ok=%v err=%v", ok, err)
	}
	sourceContext, _, err := store.GetUsageSourceForIngestion(context.Background(), source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != domain.UsageBindingActive || sourceContext.Source.State != domain.UsageSourceActive {
		t.Fatalf("binding/source states=%s/%s, want active/active", got.State, sourceContext.Source.State)
	}
}

func TestCollectorCurrentLaunchTerminalEventRemainsFinalizing(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "native-terminal", false)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	binding := seedCollectorUsageBinding(t, store, session, "native-terminal", domain.UsageBindingActive, now, "")
	if _, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "native-terminal",
		ArtifactPath:    "/tmp/native-terminal.jsonl",
		FileIdentity:    "native-terminal",
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	}); err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "process-exited",
		LaunchID:        "launch-current",
		NativeSessionID: "native-terminal",
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding ok=%v err=%v", ok, err)
	}
	if got.State != domain.UsageBindingFinalizing {
		t.Fatalf("terminal event binding state=%s, want finalizing", got.State)
	}
}

func TestCollectorOrdinaryActivityDoesNotReactivateExitedSession(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSessionWithActivity(
		t,
		store,
		domain.HarnessClaudeCode,
		"native-exited",
		false,
		domain.ActivityExited,
	)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	binding := seedCollectorUsageBinding(t, store, session, "native-exited", domain.UsageBindingFinalizing, now, "")
	source, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "native-exited",
		ArtifactPath:    "/tmp/native-exited.jsonl",
		FileIdentity:    "native-exited",
		State:           domain.UsageSourceComplete,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "post-tool-use",
		LaunchID:        "launch-current",
		NativeSessionID: "native-exited",
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding ok=%v err=%v", ok, err)
	}
	sourceContext, _, err := store.GetUsageSourceForIngestion(context.Background(), source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State == domain.UsageBindingActive || sourceContext.Source.State != domain.UsageSourceComplete {
		t.Fatalf("delayed activity reopened exited usage: binding/source=%s/%s", got.State, sourceContext.Source.State)
	}
}

func TestCollectorLateTerminalHookDoesNotCreateBindingForTerminatedSession(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "native-terminated", true)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "projects")
	path := filepath.Join(root, "workspace", "native-terminated.jsonl")
	writeUsageFixture(t, path, "{}\n")

	collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "process-exited",
		LaunchID:        "launch-current",
		NativeSessionID: "native-terminated",
		TranscriptPath:  path,
	}); err != nil {
		t.Fatal(err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 0 {
		t.Fatalf("late terminal hook created terminated-session bindings: %+v", bindings)
	}
}

func TestCollectorTerminalRecoveryRequiresProviderSource(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSessionWithActivity(
		t,
		store,
		domain.HarnessClaudeCode,
		"native-missing",
		false,
		domain.ActivityExited,
	)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "process-exited",
		LaunchID:        "launch-current",
		NativeSessionID: "native-missing",
	}); err != nil {
		t.Fatal(err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 0 {
		t.Fatalf("source-less terminal recovery created bindings: %+v", bindings)
	}
}

func TestCollectorTerminalRecoveryRegistersProvidedOrDiscoveredSource(t *testing.T) {
	for _, tt := range []struct {
		name     string
		provided bool
	}{
		{name: "provided", provided: true},
		{name: "discovered"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := collectorTestStore(t)
			session := collectorTestSessionWithActivity(
				t,
				store,
				domain.HarnessClaudeCode,
				"native-recovery",
				false,
				domain.ActivityExited,
			)
			session.Metadata.RuntimeLaunchID = "launch-current"
			if err := store.UpdateSession(context.Background(), session); err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(t.TempDir(), "projects")
			path := filepath.Join(root, "workspace", "native-recovery.jsonl")
			writeUsageFixture(t, path, "{}\n")
			signal := HookSignal{
				Event:           "process-exited",
				LaunchID:        "launch-current",
				NativeSessionID: "native-recovery",
			}
			if tt.provided {
				signal.TranscriptPath = path
			}

			collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
			if err := collector.RecordHook(context.Background(), session.ID, signal); err != nil {
				t.Fatal(err)
			}
			bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
			if err != nil || len(bindings) != 1 {
				t.Fatalf("terminal recovery bindings=%+v err=%v", bindings, err)
			}
			sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
			if err != nil || len(sources) != 1 {
				t.Fatalf("terminal recovery sources=%+v err=%v", sources, err)
			}
			if bindings[0].State != domain.UsageBindingFinalizing || sources[0].ArtifactPath != canonicalUsagePath(t, path) {
				t.Fatalf("terminal recovery binding/source=%+v/%+v", bindings[0], sources[0])
			}
		})
	}
}

func TestCollectorStaleLaunchActivityDoesNotReactivateFinalizingBinding(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "native-stale", false)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	binding := seedCollectorUsageBinding(t, store, session, "native-stale", domain.UsageBindingFinalizing, now, "")

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "post-tool-use",
		LaunchID:        "launch-stale",
		NativeSessionID: "native-stale",
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding ok=%v err=%v", ok, err)
	}
	if got.State != domain.UsageBindingFinalizing {
		t.Fatalf("stale activity binding state=%s, want finalizing", got.State)
	}
}

func TestCollectorOrdinaryEventDoesNotCreateUnsupportedHarnessBinding(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessAider, "native-unsupported", false)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}

	collector := NewCollector(store, SourceRoots{}, nil)
	if err := collector.RecordHook(context.Background(), session.ID, HookSignal{
		Event:           "post-tool-use",
		LaunchID:        "launch-current",
		NativeSessionID: "native-unsupported",
	}); err != nil {
		t.Fatal(err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 0 {
		t.Fatalf("unsupported harness bindings=%+v, want none", bindings)
	}
}

func TestCollectorCurrentActivityReactivatesBindingDuringReaperFinalization(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "native-race", false)
	now := time.Now().UTC()
	session.Activity.LastActivityAt = now.Add(-2 * time.Minute)
	session.Metadata.RuntimeLaunchID = "launch-current"
	if err := store.UpdateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	binding := seedCollectorUsageBinding(t, store, session, "native-race", domain.UsageBindingActive, now, "")

	finalized := make(chan struct{})
	release := make(chan struct{})
	collector := NewCollector(&blockedAfterFinalizeStore{
		collectorStore: store,
		finalized:      finalized,
		release:        release,
	}, SourceRoots{}, nil)
	manager := lifecycle.New(store, nil)
	manager.SetUsageFinalizer(collector)

	reaperDone := make(chan error, 1)
	go func() {
		reaperDone <- manager.ApplyRuntimeObservation(context.Background(), session.ID, ports.RuntimeFacts{
			ObservedAt: now,
			Runtime:    ports.ProbeDead,
			LaunchID:   "launch-current",
		})
	}()
	select {
	case <-finalized:
	case <-time.After(2 * time.Second):
		t.Fatal("finalizer did not commit")
	}
	during, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding during finalization ok=%v err=%v", ok, err)
	}
	if during.State != domain.UsageBindingFinalizing {
		t.Fatalf("binding during finalization=%s, want finalizing", during.State)
	}

	activityApplied := make(chan struct{})
	hookDone := make(chan error, 1)
	go func() {
		err := manager.ApplyActivitySignal(context.Background(), session.ID, ports.ActivitySignal{
			Valid:          true,
			State:          domain.ActivityActive,
			Timestamp:      now.Add(time.Second),
			Event:          "post-tool-use",
			AgentSessionID: "native-race",
			LaunchID:       "launch-current",
		})
		close(activityApplied)
		if err == nil {
			err = collector.RecordHook(context.Background(), session.ID, HookSignal{
				Event:           "post-tool-use",
				LaunchID:        "launch-current",
				NativeSessionID: "native-race",
			})
		}
		hookDone <- err
	}()
	select {
	case <-activityApplied:
	case <-time.After(2 * time.Second):
		t.Fatal("current activity did not persist while finalizer was blocked")
	}
	close(release)
	if err := <-reaperDone; err != nil {
		t.Fatal(err)
	}
	if err := <-hookDone; err != nil {
		t.Fatal(err)
	}

	gotSession, ok, err := store.GetSession(context.Background(), session.ID)
	if err != nil || !ok {
		t.Fatalf("session ok=%v err=%v", ok, err)
	}
	gotBinding, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, binding.NativeRootID)
	if err != nil || !ok {
		t.Fatalf("binding after activity ok=%v err=%v", ok, err)
	}
	if gotSession.IsTerminated || gotBinding.State != domain.UsageBindingActive {
		t.Fatalf("session terminated=%v binding=%s, want false/active", gotSession.IsTerminated, gotBinding.State)
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
	writeUsageFixture(t, path, codexSessionMetaFixture(t, "native-fenced", ""))
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

func TestCollectorRejectsHookPathAttributionMismatches(t *testing.T) {
	t.Run("Codex session id", func(t *testing.T) {
		store := collectorTestStore(t)
		session := collectorTestSession(t, store, domain.HarnessCodex, "codex-claimed", false)
		root := filepath.Join(t.TempDir(), "sessions")
		path := filepath.Join(root, "2026", "08", "02", "rollout.jsonl")
		writeUsageFixture(t, path, codexSessionMetaFixture(t, "codex-other", ""))
		collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

		err := collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:           "session-start",
			NativeSessionID: "codex-claimed",
			TranscriptPath:  path,
		})
		if err == nil {
			t.Fatal("Codex path with another session id was accepted")
		}
		assertNoUsageSourcesForSession(t, store, session.ID)
	})

	t.Run("Codex child claimed as root", func(t *testing.T) {
		store := collectorTestStore(t)
		session := collectorTestSession(t, store, domain.HarnessCodex, "codex-child", false)
		root := filepath.Join(t.TempDir(), "sessions")
		path := filepath.Join(root, "2026", "08", "02", "child.jsonl")
		writeUsageFixture(t, path, codexSessionMetaFixture(t, "codex-child", "codex-parent"))
		collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

		err := collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:           "session-start",
			NativeSessionID: "codex-child",
			TranscriptPath:  path,
		})
		if err == nil {
			t.Fatal("Codex child rollout was accepted as a root source")
		}
		assertNoUsageSourcesForSession(t, store, session.ID)
	})

	t.Run("Claude main filename", func(t *testing.T) {
		store := collectorTestStore(t)
		session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-claimed", false)
		root := filepath.Join(t.TempDir(), "projects")
		path := filepath.Join(root, "workspace", "claude-other.jsonl")
		writeUsageFixture(t, path, "{}\n")
		collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)

		err := collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:           "session-start",
			NativeSessionID: "claude-claimed",
			TranscriptPath:  path,
		})
		if err == nil {
			t.Fatal("Claude path with another root filename was accepted")
		}
		assertNoUsageSourcesForSession(t, store, session.ID)
	})

	t.Run("Claude subagent root", func(t *testing.T) {
		store := collectorTestStore(t)
		session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-root", false)
		root := filepath.Join(t.TempDir(), "projects")
		path := filepath.Join(root, "workspace", "claude-other", "subagents", "agent-sub-1.jsonl")
		writeUsageFixture(t, path, "{}\n")
		collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)

		err := collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:                  "subagent-stop",
			NativeSessionID:        "claude-root",
			SubagentID:             "sub-1",
			SubagentTranscriptPath: path,
		})
		if err == nil {
			t.Fatal("Claude subagent path under another root session was accepted")
		}
		assertNoUsageSourcesForSession(t, store, session.ID)
	})

	t.Run("Claude subagent id", func(t *testing.T) {
		store := collectorTestStore(t)
		session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-root", false)
		root := filepath.Join(t.TempDir(), "projects")
		path := filepath.Join(root, "workspace", "claude-root", "subagents", "agent-sub-other.jsonl")
		writeUsageFixture(t, path, "{}\n")
		collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)

		err := collector.RecordHook(context.Background(), session.ID, HookSignal{
			Event:                  "subagent-stop",
			NativeSessionID:        "claude-root",
			SubagentID:             "sub-1",
			SubagentTranscriptPath: path,
		})
		if err == nil {
			t.Fatal("Claude subagent path with another agent id was accepted")
		}
		assertNoUsageSourcesForSession(t, store, session.ID)
	})
}

func TestCollectorRejectsCodexChildPathWithWrongParent(t *testing.T) {
	ctx := context.Background()
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "codex-root", false)
	now := time.Unix(1700000000, 0).UTC()
	binding := seedCollectorUsageBinding(t, store, session, "codex-root", domain.UsageBindingActive, now, "")
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "08", "02", "child.jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, "codex-child", "codex-wrong-parent"))
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

	if _, err := collector.registerSource(
		ctx,
		binding,
		domain.UsageSourceCodexRollout,
		"codex-child",
		"codex-child",
		path,
		now,
		false,
	); err == nil {
		t.Fatal("Codex child path with another parent was accepted")
	}
	assertNoUsageSourcesForSession(t, store, session.ID)
}

func TestCollectorPersistsCodexChildDirectParent(t *testing.T) {
	const (
		parentID = "11111111-1111-4111-8111-111111111111"
		childID  = "22222222-2222-4222-8222-222222222222"
	)
	ctx := context.Background()
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, parentID, false)
	now := time.Unix(1700000000, 0).UTC()
	binding := seedCollectorUsageBinding(t, store, session, parentID, domain.UsageBindingActive, now, "")
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "08", "02", "child.jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, childID, parentID))
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)

	if _, err := collector.registerSourceWithExpectedParent(
		ctx,
		binding,
		domain.UsageSourceCodexRollout,
		childID,
		childID,
		path,
		now,
		false,
		parentID,
	); err != nil {
		t.Fatalf("register child: %v", err)
	}
	sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("child sources = %+v, err=%v", sources, err)
	}
	var state struct {
		Version    int                    `json:"version"`
		SourceKind domain.UsageSourceKind `json:"source_kind"`
		Codex      *struct {
			NativeSessionID string `json:"native_session_id"`
			DirectParentID  string `json:"direct_parent_id"`
		} `json:"codex"`
	}
	if err := json.Unmarshal([]byte(sources[0].ParserStateJSON), &state); err != nil {
		t.Fatalf("decode child parser state: %v", err)
	}
	if state.Version != 1 || state.SourceKind != domain.UsageSourceCodexRollout ||
		state.Codex == nil || state.Codex.NativeSessionID != childID || state.Codex.DirectParentID != parentID {
		t.Fatalf("child parser state = %s", sources[0].ParserStateJSON)
	}
}

func TestCollectorDoesNotDoubleAttributeCodexChildAsRoot(t *testing.T) {
	ctx := context.Background()
	store := collectorTestStore(t)
	parentSession := collectorTestSession(t, store, domain.HarnessCodex, "codex-parent", false)
	root := filepath.Join(t.TempDir(), "sessions")
	childPath := filepath.Join(root, "2026", "08", "02", "child.jsonl")
	writeUsageFixture(t, childPath, codexSessionMetaFixture(t, "codex-child", "codex-parent"))
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	now := time.Unix(1700000000, 0).UTC()
	parentBinding := seedCollectorUsageBinding(
		t, store, parentSession, "codex-parent", domain.UsageBindingActive, now, "",
	)
	if _, err := collector.registerSource(
		ctx,
		parentBinding,
		domain.UsageSourceCodexRollout,
		"codex-child",
		"codex-child",
		childPath,
		now,
		false,
	); err != nil {
		t.Fatalf("register child under parent: %v", err)
	}

	childSession := collectorTestSession(t, store, domain.HarnessCodex, "codex-child", false)
	if err := collector.RecordHook(ctx, childSession.ID, HookSignal{
		Event:           "session-start",
		NativeSessionID: "codex-child",
		TranscriptPath:  childPath,
	}); err == nil {
		t.Fatal("child rollout was also accepted as a root source")
	}
	parentSources, err := store.ListUsageSourcesForBinding(ctx, parentBinding.ID)
	if err != nil || len(parentSources) != 1 || parentSources[0].SubagentID != "codex-child" {
		t.Fatalf("parent sources = %+v, err=%v", parentSources, err)
	}
	assertNoUsageSourcesForSession(t, store, childSession.ID)
}

func TestCollectorAttributionMismatchDoesNotReplaceExistingSource(t *testing.T) {
	ctx := context.Background()
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, "codex-root", false)
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "08", "02", "rollout.jsonl")
	writeUsageFixture(t, path, codexSessionMetaFixture(t, "codex-root", ""))
	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	signal := HookSignal{
		Event:           "session-start",
		NativeSessionID: "codex-root",
		TranscriptPath:  path,
	}
	if err := collector.RecordHook(ctx, session.ID, signal); err != nil {
		t.Fatalf("register original source: %v", err)
	}
	binding, ok, err := store.GetUsageBinding(ctx, session.ID, session.Harness, "codex-root")
	if err != nil || !ok {
		t.Fatalf("binding: ok=%v err=%v", ok, err)
	}
	sources, err := store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("original sources=%+v err=%v", sources, err)
	}
	original := sources[0]
	replacement := path + ".replacement"
	writeUsageFixture(t, replacement, codexSessionMetaFixture(t, "codex-other", ""))
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}

	if err := collector.RecordHook(ctx, session.ID, signal); err == nil {
		t.Fatal("mismatched replacement was accepted")
	}
	sources, err = store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("sources after rejection=%+v err=%v", sources, err)
	}
	if sources[0].ID != original.ID || sources[0].State != original.State ||
		sources[0].LastErrorCode != original.LastErrorCode {
		t.Fatalf("original source changed after rejection: before=%+v after=%+v", original, sources[0])
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
	binding := seedCollectorUsageBinding(t, store, session, "native-complete", domain.UsageBindingComplete, now, "")
	identity, err := SourceIdentity(context.Background(), path)
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

func TestCollectorRegisteringClaudeSiblingDoesNotRetireExistingSubagent(t *testing.T) {
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessClaudeCode, "claude-siblings", false)
	root := filepath.Join(t.TempDir(), "projects")
	mainPath := filepath.Join(root, "workspace", "claude-siblings.jsonl")
	firstPath := filepath.Join(root, "workspace", "claude-siblings", "subagents", "agent-first.jsonl")
	secondPath := filepath.Join(root, "workspace", "claude-siblings", "subagents", "agent-second.jsonl")
	writeUsageFixture(t, mainPath, `{"type":"assistant"}`+"\n")
	writeUsageFixture(t, firstPath, `{"type":"assistant","agent":"first"}`+"\n")
	writeUsageFixture(t, secondPath, `{"type":"assistant","agent":"second"}`+"\n")

	collector := NewCollector(store, SourceRoots{ClaudeProjects: root}, nil)
	if err := collector.BackfillActive(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	states := make(map[string]domain.UsageSourceState)
	for _, source := range sources {
		if source.Kind == domain.UsageSourceClaudeSubagent {
			states[source.SubagentID] = source.State
		}
	}
	if states["first"] != domain.UsageSourcePending || states["second"] != domain.UsageSourcePending {
		t.Fatalf("Claude sibling states = %+v, sources=%+v", states, sources)
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
	binding := seedCollectorUsageBinding(t, store, session, "claude-late", domain.UsageBindingComplete, now, "")
	identity, err := SourceIdentity(context.Background(), subagentPath)
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

	paths, err := discoverClaudeSubagentPaths(context.Background(), mainPath)
	if err != nil {
		t.Fatal(err)
	}
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
	binding := seedCollectorUsageBinding(t, store, session, "native-resume", domain.UsageBindingComplete, now, "")
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
	if err := store.ApplyUsageChunk(context.Background(), sources[0].ID, 0, domain.SourceCursorState{
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
	if err := store.ApplyUsageChunk(context.Background(), childSource.ID, 0, domain.SourceCursorState{
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

func TestCollectorIgnoresChildrenFromSupersededCodexGeneration(t *testing.T) {
	store := collectorTestStore(t)
	const (
		rootID  = "11111111-1111-4111-8111-111111111111"
		childID = "22222222-2222-4222-8222-222222222222"
	)
	session := collectorTestSession(t, store, domain.HarnessCodex, rootID, false)
	now := time.Now().UTC()
	binding := seedCollectorUsageBinding(t, store, session, rootID, domain.UsageBindingActive, now, "")
	root := filepath.Join(t.TempDir(), "sessions")
	childPath := filepath.Join(root, "2026", "07", "28", "rollout-"+childID+".jsonl")
	writeUsageFixture(t, childPath, codexSessionMetaFixture(t, childID, rootID))
	oldState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + childID + `"]}}`
	emptyState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	for generation, state := range []string{oldState, emptyState} {
		if _, err := store.InsertUsageSource(context.Background(), domain.UsageSourceRecord{
			BindingID:       binding.ID,
			Kind:            domain.UsageSourceCodexRollout,
			NativeSessionID: rootID,
			ArtifactPath:    filepath.Join(root, "rollout-root.jsonl"),
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

	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	if err := collector.registerDiscoveredCodexChildren(context.Background(), binding, now); err != nil {
		t.Fatalf("register children: %v", err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), binding.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range sources {
		if source.NativeSessionID == childID {
			t.Fatalf("registered stale child from superseded generation: %+v", source)
		}
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
	binding := seedCollectorUsageBinding(t, store, session, "native-resume-late", domain.UsageBindingComplete, now, "")
	identity, err := SourceIdentity(context.Background(), archivedPath)
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
	binding := seedCollectorUsageBinding(t, store, session, "root-native", domain.UsageBindingActive, now, "")
	root := t.TempDir()
	firstPath := filepath.Join(root, "first.jsonl")
	secondPath := filepath.Join(root, "second.jsonl")
	firstContent := codexSessionMetaFixture(t, "native-a", "") + strings.Repeat(" ", 256)
	if err := os.WriteFile(firstPath, []byte(firstContent), 0o600); err != nil {
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
	if err := store.ApplyUsageChunk(context.Background(), sources[0].ID, 0, domain.SourceCursorState{
		ByteOffset: 100,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, nil); err != nil {
		t.Fatal(err)
	}
	secondContent := codexSessionMetaFixture(t, "native-b", "") + strings.Repeat(" ", 256)
	if err := rewriteCollectorFixture(secondPath, secondContent); err != nil {
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
	binding := seedCollectorUsageBinding(t, store, session, "native-relocated", domain.UsageBindingComplete, now, "")
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
	if err := collector.FinalizeSession(
		context.Background(),
		session.ID,
		session.Metadata.RuntimeLaunchID,
		session.UpdatedAt,
	); err != nil {
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
	got, err := collector.discoverCodexPath(context.Background(), nativeID, "")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("unconfigured Codex roots discovered %q", got)
	}
}

func TestReconcileCodexRootAcceptsScalarSourceMetadata(t *testing.T) {
	const nativeID = "11111111-1111-4111-8111-111111111111"
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessCodex, nativeID, false)
	root := filepath.Join(t.TempDir(), "sessions")
	path := filepath.Join(root, "2026", "08", "02", "rollout-"+nativeID+".jsonl")
	writeUsageFixture(t, path, `{"type":"session_meta","payload":{"id":"`+nativeID+`","source":"cli"}}`+"\n")
	now := time.Now().UTC()
	binding := seedCollectorUsageBinding(
		t, store, session, nativeID, domain.UsageBindingActive, now, domain.UsageErrorSourceDiscoveryPending,
	)

	collector := NewCollector(store, SourceRoots{CodexSessions: root}, nil)
	if err := collector.ReconcileSources(context.Background(), 8); err != nil {
		t.Fatalf("reconcile scalar-source rollout: %v", err)
	}

	got, ok, err := store.GetUsageBinding(context.Background(), session.ID, session.Harness, nativeID)
	if err != nil || !ok {
		t.Fatalf("get reconciled binding: ok=%v err=%v", ok, err)
	}
	if got.LastErrorCode != "" {
		t.Fatalf("binding error = %q, want cleared", got.LastErrorCode)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), binding.ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("sources = %+v, err=%v; want one registered rollout", sources, err)
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
	first, err := SourceIdentity(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, previous); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := SourceIdentity(context.Background(), path)
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
	emptyIdentity, err := SourceIdentity(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"type":"session_meta"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writtenIdentity, err := SourceIdentity(context.Background(), path)
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

	_, _, _, err := collector.validateSourcePath(context.Background(), domain.HarnessCodex, secretPath)
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

func seedCollectorUsageBinding(
	t *testing.T,
	store *sqlite.Store,
	session domain.SessionRecord,
	nativeRootID string,
	state domain.UsageBindingState,
	at time.Time,
	lastErrorCode string,
) domain.UsageBindingRecord {
	t.Helper()
	binding, err := store.UpsertUsageBinding(context.Background(), domain.UsageBindingRecord{
		SessionID:     session.ID,
		Harness:       session.Harness,
		NativeRootID:  nativeRootID,
		State:         state,
		LastErrorCode: lastErrorCode,
		FirstSeenAt:   at,
		LastSeenAt:    at,
		UpdatedAt:     at,
	})
	if err != nil {
		t.Fatal(err)
	}
	return binding
}

func assertNoUsageSourcesForSession(t *testing.T, store *sqlite.Store, sessionID domain.SessionID) {
	t.Helper()
	bindings, err := store.ListUsageBindingsForSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range bindings {
		sources, err := store.ListUsageSourcesForBinding(context.Background(), binding.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(sources) != 0 {
			t.Fatalf("unexpected usage sources: %+v", sources)
		}
	}
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

func rewriteCollectorFixture(path, content string) error {
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
