package lifecycle

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var ctx = context.Background()

type fakeStore struct {
	sessions   map[domain.SessionID]domain.SessionRecord
	prs        map[domain.SessionID][]domain.PullRequest
	signatures map[string]string

	signatureWriteErr error
	signatureWrites   int
}

func newFakeStore() *fakeStore {
	return &fakeStore{sessions: map[domain.SessionID]domain.SessionRecord{}, prs: map[domain.SessionID][]domain.PullRequest{}, signatures: map[string]string{}}
}

func (f *fakeStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	r, ok := f.sessions[id]
	return r, ok, nil
}

func (f *fakeStore) ListPRsBySession(_ context.Context, id domain.SessionID) ([]domain.PullRequest, error) {
	return f.prs[id], nil
}

func (f *fakeStore) UpdateSession(_ context.Context, rec domain.SessionRecord) error {
	f.sessions[rec.ID] = rec
	return nil
}

func (f *fakeStore) GetPRLastNudgeSignature(_ context.Context, prURL string) (string, error) {
	return f.signatures[prURL], nil
}

func (f *fakeStore) UpdatePRLastNudgeSignature(_ context.Context, prURL, payload string) error {
	if f.signatureWriteErr != nil {
		return f.signatureWriteErr
	}
	if f.signatures == nil {
		f.signatures = map[string]string{}
	}
	f.signatures[prURL] = payload
	f.signatureWrites++
	return nil
}

type fakeMessenger struct {
	msgs []string
	err  error
}

type telemetrySink struct {
	events []ports.TelemetryEvent
}

func (s *telemetrySink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	s.events = append(s.events, ev)
}

func (*telemetrySink) Close(context.Context) error { return nil }

func (f *fakeMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	if f.err != nil {
		return f.err
	}
	f.msgs = append(f.msgs, msg)
	return nil
}

func newManager() (*Manager, *fakeStore, *fakeMessenger) {
	st := newFakeStore()
	msg := &fakeMessenger{}
	return New(st, msg), st, msg
}

func working(id domain.SessionID) domain.SessionRecord {
	return domain.SessionRecord{ID: id, ProjectID: "mer", Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: time.Now()}}
}

func TestRuntimeObservation_InferredDeathSetsTerminated(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.Activity.LastActivityAt = time.Now().Add(-2 * time.Minute)
	st.sessions["mer-1"] = rec
	if err := m.ApplyRuntimeObservation(ctx, "mer-1", ports.RuntimeFacts{Probe: ports.ProbeDead}); err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"]
	if !got.IsTerminated || got.Activity.State != domain.ActivityExited {
		t.Fatalf("want terminated/exited, got %+v", got)
	}
	if got.TerminalFailureReason != "runtime probe reported dead" {
		t.Fatalf("TerminalFailureReason = %q, want runtime death reason", got.TerminalFailureReason)
	}
}

// A session mid agent-switch has no live runtime by design; the reaper's "dead"
// fact must not terminate it while BeginSwitch is in effect.
func TestRuntimeObservation_SwitchingSuppressesTermination(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.Activity.LastActivityAt = time.Now().Add(-2 * time.Minute) // otherwise-clearly-dead
	st.sessions["mer-1"] = rec

	if !m.TryBeginSwitch("mer-1") {
		t.Fatal("TryBeginSwitch should succeed on a session not already switching")
	}
	if m.TryBeginSwitch("mer-1") {
		t.Fatal("TryBeginSwitch should fail while a switch is already in flight")
	}
	if err := m.ApplyRuntimeObservation(ctx, "mer-1", ports.RuntimeFacts{Probe: ports.ProbeDead}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatal("switching session was terminated by the reaper; guard failed")
	}

	// After the switch ends, the guard no longer applies.
	m.EndSwitch("mer-1")
	if err := m.ApplyRuntimeObservation(ctx, "mer-1", ports.RuntimeFacts{Probe: ports.ProbeDead}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated {
		t.Fatal("post-switch dead probe should terminate")
	}
}

func TestActivitySignal_StoresPendingQuestionDecision(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")

	err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{
		Valid: true,
		State: domain.ActivityBlocked,
		PendingDecision: &domain.PendingDecision{
			Kind:     domain.DecisionKindQuestion,
			Question: "Choose lane",
			Options:  []string{"API", "Terminal"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"].Metadata.PendingDecision
	if got == nil || got.Kind != domain.DecisionKindQuestion || got.Question != "Choose lane" {
		t.Fatalf("PendingDecision = %#v", got)
	}
	if !reflect.DeepEqual(got.Options, []string{"API", "Terminal"}) {
		t.Fatalf("options = %#v", got.Options)
	}
}

func TestActivitySignal_ClearsPendingDecisionWhenUnblocked(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.Activity = domain.Activity{State: domain.ActivityBlocked, LastActivityAt: time.Now().Add(-time.Second)}
	rec.Metadata.PendingDecision = &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "Choose lane"}
	st.sessions["mer-1"] = rec

	err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityActive})
	if err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Metadata.PendingDecision; got != nil {
		t.Fatalf("PendingDecision = %#v, want nil", got)
	}
}

func TestActivitySignal_UpdatesPendingDecisionOnRepeatedBlockedState(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.Activity = domain.Activity{State: domain.ActivityBlocked, LastActivityAt: time.Now().Add(-time.Second)}
	rec.FirstSignalAt = time.Now().Add(-time.Second)
	rec.Metadata.PendingDecision = &domain.PendingDecision{Kind: domain.DecisionKindPermission}
	st.sessions["mer-1"] = rec

	err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{
		Valid: true,
		State: domain.ActivityBlocked,
		PendingDecision: &domain.PendingDecision{
			Kind:     domain.DecisionKindQuestion,
			Question: "Choose lane",
			Options:  []string{"API", "Terminal"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"].Metadata.PendingDecision
	if got == nil || got.Kind != domain.DecisionKindQuestion || got.Question != "Choose lane" {
		t.Fatalf("PendingDecision = %#v, want question", got)
	}
}

func TestMarkSwitched_ChangesHarnessAndClearsAgentSessionID(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:                    "mer-1",
		ProjectID:             "mer",
		Harness:               domain.HarnessClaudeCode,
		IsTerminated:          true,
		TerminalFailureReason: "runtime probe reported dead",
		FirstSignalAt:         time.Now(),
		Metadata:              domain.SessionMetadata{RuntimeHandleID: "old", AgentSessionID: "old-native", Prompt: "p", Branch: "b", WorkspacePath: "/ws"},
	}
	// A relaunch may restore to a different worktree path/branch; MarkSwitched
	// must persist them (not keep the stale ones).
	switched := domain.SessionMetadata{
		RuntimeHandleID:   "new-handle",
		RuntimeToken:      "new-token",
		WorkspacePath:     "/ws2",
		Branch:            "b2",
		Prompt:            "new prompt",
		Model:             "switch-model",
		LaunchedHarnesses: []domain.AgentHarness{domain.HarnessClaudeCode, domain.HarnessCodex},
	}
	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, switched); err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"]
	if got.Harness != domain.HarnessCodex {
		t.Fatalf("harness = %q, want codex", got.Harness)
	}
	if got.Metadata.AgentSessionID != "" {
		t.Fatalf("AgentSessionID = %q, want cleared", got.Metadata.AgentSessionID)
	}
	if got.Metadata.RuntimeHandleID != "new-handle" {
		t.Fatalf("RuntimeHandleID = %q, want new-handle", got.Metadata.RuntimeHandleID)
	}
	if got.Metadata.RuntimeToken != "new-token" {
		t.Fatalf("RuntimeToken = %q, want new-token", got.Metadata.RuntimeToken)
	}
	if got.Metadata.Model != "switch-model" {
		t.Fatalf("Model = %q, want switch-model", got.Metadata.Model)
	}
	if got.Metadata.Prompt != "new prompt" {
		t.Fatalf("Prompt = %q, want new prompt", got.Metadata.Prompt)
	}
	if got.Metadata.WorkspacePath != "/ws2" || got.Metadata.Branch != "b2" {
		t.Fatalf("workspace path/branch not persisted: %+v", got.Metadata)
	}
	if len(got.Metadata.LaunchedHarnesses) != 2 {
		t.Fatalf("launched harnesses = %v, want 2", got.Metadata.LaunchedHarnesses)
	}
	if !got.FirstSignalAt.IsZero() {
		t.Fatal("FirstSignalAt should reset so the new agent re-proves its hooks")
	}
	if got.IsTerminated || got.TerminalFailureReason != "" {
		t.Fatalf("switch should revive session and clear terminal reason, got terminated=%v reason=%q", got.IsTerminated, got.TerminalFailureReason)
	}
}

func TestActivity_StaleExitAfterSwitchIsSuppressed(t *testing.T) {
	m, st, _ := newManager()
	now := time.Unix(100, 0).UTC()
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessClaudeCode,
		Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "old", RuntimeToken: "old-token", AgentSessionID: "old-native", Prompt: "p", Branch: "b", WorkspacePath: "/ws"},
	}
	switched := domain.SessionMetadata{RuntimeHandleID: "new-handle", RuntimeToken: "new-token", WorkspacePath: "/ws", Branch: "b"}
	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, switched); err != nil {
		t.Fatal(err)
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessClaudeCode, RuntimeToken: "old-token"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatalf("stale exit hook terminated switched session: %+v", got)
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessCodex, RuntimeToken: "new-token"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated || got.Activity.State != domain.ActivityExited {
		t.Fatalf("current harness exit during suppression window was ignored: %+v", got)
	}
	if got := st.sessions["mer-1"]; got.TerminalFailureReason != "" {
		t.Fatalf("TerminalFailureReason = %q, want no reason for clean activity exit", got.TerminalFailureReason)
	}

	st.sessions["mer-2"] = domain.SessionRecord{
		ID: "mer-2", ProjectID: "mer", Harness: domain.HarnessCodex,
		Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "newer", RuntimeToken: "older-token", Prompt: "p", Branch: "b", WorkspacePath: "/ws2"},
	}
	if err := m.MarkSwitched(ctx, "mer-2", domain.HarnessCodex, switched); err != nil {
		t.Fatal(err)
	}
	now = now.Add(31 * time.Second)
	if err := m.ApplyActivitySignal(ctx, "mer-2", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessClaudeCode, RuntimeToken: "older-token"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-2"]; got.IsTerminated {
		t.Fatalf("old-token exit after suppression window terminated switched session: %+v", got)
	}
}

func TestActivity_PreTokenSwitchExitSuppressionExpires(t *testing.T) {
	m, st, _ := newManager()
	now := time.Unix(150, 0).UTC()
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessClaudeCode,
		Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "old", Prompt: "p", Branch: "b", WorkspacePath: "/ws"},
	}
	switched := domain.SessionMetadata{RuntimeHandleID: "new-handle", WorkspacePath: "/ws", Branch: "b"}
	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, switched); err != nil {
		t.Fatal(err)
	}
	now = now.Add(31 * time.Second)
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessClaudeCode}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated || got.Activity.State != domain.ActivityExited {
		t.Fatalf("pre-token exit after suppression window was ignored: %+v", got)
	}
}

func TestActivity_SameHarnessSwitchSuppressesOnlyOldRuntimeToken(t *testing.T) {
	m, st, _ := newManager()
	now := time.Unix(200, 0).UTC()
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessCodex,
		Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "old", RuntimeToken: "old-token", Prompt: "p", Branch: "b", WorkspacePath: "/ws"},
	}
	switched := domain.SessionMetadata{RuntimeHandleID: "new-handle", RuntimeToken: "new-token", WorkspacePath: "/ws", Branch: "b"}
	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, switched); err != nil {
		t.Fatal(err)
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessCodex, RuntimeToken: "old-token"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatalf("old same-harness runtime exit terminated switched session: %+v", got)
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessCodex, RuntimeToken: "new-token"}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated || got.Activity.State != domain.ActivityExited {
		t.Fatalf("new same-harness runtime exit was ignored: %+v", got)
	}
}

func TestActivity_MissingRuntimeTokenDuringSwitchIsTreatedAsStale(t *testing.T) {
	m, st, _ := newManager()
	now := time.Unix(300, 0).UTC()
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessCodex,
		Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "old", RuntimeToken: "old-token", Prompt: "p", Branch: "b", WorkspacePath: "/ws"},
	}
	if err := m.MarkSwitched(ctx, "mer-1", domain.HarnessCodex, domain.SessionMetadata{RuntimeHandleID: "new-handle", RuntimeToken: "new-token", WorkspacePath: "/ws", Branch: "b"}); err != nil {
		t.Fatal(err)
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityExited, Harness: domain.HarnessCodex}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatalf("missing-token stale exit terminated switched session: %+v", got)
	}
}

func TestRuntimeObservation_FailedProbeDoesNotMutate(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	before := st.sessions["mer-1"]
	if err := m.ApplyRuntimeObservation(ctx, "mer-1", ports.RuntimeFacts{Probe: ports.ProbeFailed}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st.sessions["mer-1"], before) {
		t.Fatalf("failed probe should not persist a state, got %+v", st.sessions["mer-1"])
	}
}

func TestActivity_InvalidIsIgnored(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	before := st.sessions["mer-1"]
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: false, State: domain.ActivityIdle}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st.sessions["mer-1"], before) {
		t.Fatal("invalid signal must not mutate")
	}
}

func TestActivity_MissingSessionReturnsNotFound(t *testing.T) {
	m, _, _ := newManager()
	err := m.ApplyActivitySignal(ctx, "missing-1", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput})
	if !errors.Is(err, ports.ErrSessionNotFound) {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}

func TestMarkTerminated(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	if err := m.MarkTerminated(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"]
	if !got.IsTerminated || got.Activity.State != domain.ActivityExited {
		t.Fatalf("want terminated/exited, got %+v", got)
	}
}

func TestMarkSpawnedStoresRuntimeMetadata(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:                    "mer-1",
		ProjectID:             "mer",
		IsTerminated:          true,
		TerminalFailureReason: "runtime probe reported dead",
		Metadata: domain.SessionMetadata{
			Model:             "spawn-model",
			PreviewURL:        "http://localhost:5173/",
			PreviewRevision:   2,
			LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex},
		},
	}
	metadata := domain.SessionMetadata{
		Branch:            "b",
		WorkspacePath:     "/ws",
		RuntimeHandleID:   "h1",
		AgentSessionID:    "agent",
		Prompt:            "prompt",
		Model:             "restore-model",
		PreviewURL:        "http://localhost:3000/",
		PreviewRevision:   3,
		LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode},
	}
	if err := m.MarkSpawned(ctx, "mer-1", metadata); err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"]
	if got.IsTerminated || got.Activity.State != domain.ActivityIdle || got.Metadata.RuntimeHandleID != "h1" {
		t.Fatalf("spawn metadata wrong: %+v", got)
	}
	if got.TerminalFailureReason != "" {
		t.Fatalf("TerminalFailureReason = %q, want cleared on spawn", got.TerminalFailureReason)
	}
	if got.Metadata.Model != "restore-model" {
		t.Fatalf("model = %q, want restore-model", got.Metadata.Model)
	}
	if got.Metadata.PreviewURL != "http://localhost:3000/" || got.Metadata.PreviewRevision != 3 {
		t.Fatalf("preview metadata = (%q, %d), want updated preview", got.Metadata.PreviewURL, got.Metadata.PreviewRevision)
	}
	if !reflect.DeepEqual(got.Metadata.LaunchedHarnesses, []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode}) {
		t.Fatalf("launched harnesses = %v, want codex and claude-code", got.Metadata.LaunchedHarnesses)
	}
}

// TestMarkSpawned_StampsUTCActivity locks the lifecycle clock to UTC so
// activity-driven timestamps match the session manager's spawn timestamps. A
// local clock here left `ao session get` showing created in UTC but updated in
// local time.
func TestMarkSpawned_StampsUTCActivity(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", IsTerminated: true}
	if err := m.MarkSpawned(ctx, "mer-1", domain.SessionMetadata{RuntimeHandleID: "h1"}); err != nil {
		t.Fatal(err)
	}
	if loc := st.sessions["mer-1"].Activity.LastActivityAt.Location(); loc != time.UTC {
		t.Fatalf("LastActivityAt location = %v, want UTC", loc)
	}
}

func TestActivity_WaitingInputEntryAndExitEmitTelemetry(t *testing.T) {
	st := newFakeStore()
	sink := &telemetrySink{}
	m := New(st, nil, WithTelemetry(sink))
	now := time.Unix(100, 0).UTC()
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Minute)},
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput, Timestamp: now}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(3 * time.Second)
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Timestamp: now}); err != nil {
		t.Fatal(err)
	}

	if len(sink.events) != 2 {
		t.Fatalf("events = %#v, want waiting_input entered/exited", sink.events)
	}
	if sink.events[0].Name != "ao.session.waiting_input_entered" || sink.events[1].Name != "ao.session.waiting_input_exited" {
		t.Fatalf("event names = %#v", []string{sink.events[0].Name, sink.events[1].Name})
	}
	if got := sink.events[1].Payload["dwell_ms"]; got != int64(3000) {
		t.Fatalf("dwell_ms = %#v, want 3000", got)
	}
}

func TestPRObservation_CIFailingNudgesAgentWithLogs(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{Fetched: true, URL: "pr1", CI: domain.CIFailing, Checks: []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 || !strings.Contains(msg.msgs[0], "boom") {
		t.Fatalf("want one CI nudge with log tail, got %v", msg.msgs)
	}
}

func TestPRObservation_ReviewCommentsNudgeAgent(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{Fetched: true, URL: "pr1", Review: domain.ReviewChangesRequest, Comments: []ports.PRCommentObservation{{ID: "1", Author: "alice", Body: "fix this"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 || !strings.Contains(msg.msgs[0], "fix this") {
		t.Fatalf("want review nudge, got %v", msg.msgs)
	}
}

func TestPRObservation_ReviewNudgeNotStarvedByDedupedCI(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")

	// First observation: CI failing on commit c1 → one CI nudge.
	ci := ports.PRObservation{Fetched: true, URL: "pr1", CI: domain.CIFailing,
		Checks: []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", ci); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("want one CI nudge first, got %v", msg.msgs)
	}

	// Second observation: CI unchanged (same commit + output → dedup no-op) while a
	// reviewer now leaves feedback. The deduped CI lane must not starve the
	// independent review lane, so the review nudge is still delivered.
	withReview := ci
	withReview.Review = domain.ReviewChangesRequest
	withReview.Comments = []ports.PRCommentObservation{{ID: "c9", Author: "alice", Body: "please fix"}}
	if err := m.ApplyPRObservation(ctx, "mer-1", withReview); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 2 || !strings.Contains(msg.msgs[1], "please fix") {
		t.Fatalf("review feedback starved by deduped CI nudge, got %v", msg.msgs)
	}
}

func TestPRObservation_AllActionableSignalsNudgeAgent(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{
		Fetched:      true,
		URL:          "pr1",
		CI:           domain.CIFailing,
		Checks:       []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}},
		Review:       domain.ReviewChangesRequest,
		Comments:     []ports.PRCommentObservation{{ID: "c9", Author: "alice", Body: "please fix"}},
		Mergeability: domain.MergeConflicting,
	}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 3 {
		t.Fatalf("want CI, review, and merge-conflict nudges, got %v", msg.msgs)
	}
	if !strings.Contains(msg.msgs[0], "boom") || !strings.Contains(msg.msgs[1], "please fix") || !strings.Contains(msg.msgs[2], "merge conflicts") {
		t.Fatalf("unexpected nudge sequence: %v", msg.msgs)
	}
}

func TestPRObservation_DuplicateCheckNamesDoNotAlternateAndStarveReview(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")

	ci := ports.PRObservation{Fetched: true, URL: "pr1", CI: domain.CIFailing,
		Checks: []ports.PRCheckObservation{
			{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, URL: "ci/1", LogTail: "first"},
			{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, URL: "ci/2", LogTail: "second"},
		}}

	if err := m.ApplyPRObservation(ctx, "mer-1", ci); err != nil {
		t.Fatal(err)
	}
	if err := m.ApplyPRObservation(ctx, "mer-1", ci); err != nil {
		t.Fatal(err)
	}
	withReview := ci
	withReview.Review = domain.ReviewChangesRequest
	withReview.Comments = []ports.PRCommentObservation{{ID: "c9", Author: "alice", Body: "please fix"}}
	if err := m.ApplyPRObservation(ctx, "mer-1", withReview); err != nil {
		t.Fatal(err)
	}

	if len(msg.msgs) != 3 {
		t.Fatalf("want two CI nudges and one review nudge, got %v", msg.msgs)
	}
	if !strings.Contains(msg.msgs[0], "first") || !strings.Contains(msg.msgs[1], "second") || !strings.Contains(msg.msgs[2], "please fix") {
		t.Fatalf("unexpected nudge sequence: %v", msg.msgs)
	}
}

func TestPRObservation_CINudgeSanitizesLogTailControlChars(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	// A CI log tail with an embedded ANSI escape sequence and a NUL byte; the
	// agent's pane must receive the visible text without the control bytes.
	o := ports.PRObservation{Fetched: true, URL: "pr1", CI: domain.CIFailing, Checks: []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "line1\x1b[2Jline2\x00\ttabbed"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("want one CI nudge, got %v", msg.msgs)
	}
	got := msg.msgs[0]
	if strings.ContainsRune(got, '\x1b') || strings.ContainsRune(got, '\x00') {
		t.Fatalf("nudge still carries control bytes: %q", got)
	}
	if !strings.Contains(got, "line1") || !strings.Contains(got, "line2") || !strings.Contains(got, "\ttabbed") {
		t.Fatalf("nudge dropped visible text or tab: %q", got)
	}
}

func TestPRObservation_ReviewNudgeSanitizesCommentControlChars(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{Fetched: true, URL: "pr1", Review: domain.ReviewChangesRequest, Comments: []ports.PRCommentObservation{{ID: "1", Body: "please\x1b]0;pwned\afix this"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("want one review nudge, got %v", msg.msgs)
	}
	got := msg.msgs[0]
	if strings.ContainsRune(got, '\x1b') || strings.ContainsRune(got, '\a') {
		t.Fatalf("review nudge still carries control bytes: %q", got)
	}
	if !strings.Contains(got, "please") || !strings.Contains(got, "fix this") {
		t.Fatalf("review nudge dropped visible text: %q", got)
	}
}

func TestSCMObservationProjectsToExistingPRReactions(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.SCMObservation{
		Fetched: true,
		PR:      ports.SCMPRObservation{URL: "pr1", Number: 1},
		CI: ports.SCMCIObservation{
			Summary: string(domain.CIFailing),
			HeadSHA: "c1",
			FailedChecks: []ports.SCMCheckObservation{{
				Name: "build", Status: string(domain.PRCheckFailed), LogTail: "boom",
			}},
		},
	}
	if err := m.ApplySCMObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 || !strings.Contains(msg.msgs[0], "boom") {
		t.Fatalf("want SCM CI nudge with log tail, got %v", msg.msgs)
	}
}

func TestSCMObservation_MissingSessionIsIgnored(t *testing.T) {
	st := newFakeStore()
	m := New(st, nil)
	o := ports.SCMObservation{
		Fetched: true,
		PR:      ports.SCMPRObservation{URL: "pr1", Number: 1},
	}
	if err := m.ApplySCMObservation(ctx, "missing-1", o); err != nil {
		t.Fatalf("ApplySCMObservation missing session: %v", err)
	}
}

func TestSCMObservationUsesPRHeadWhenCIHeadMissing(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.SCMObservation{
		Fetched: true,
		PR:      ports.SCMPRObservation{URL: "pr1", HeadSHA: "c1"},
		CI: ports.SCMCIObservation{
			Summary: string(domain.CIFailing),
			FailedChecks: []ports.SCMCheckObservation{{
				Name: "build", Status: string(domain.PRCheckFailed),
			}},
		},
	}
	if err := m.ApplySCMObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	o.PR.HeadSHA = "c2"
	if err := m.ApplySCMObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("want separate CI nudges for distinct PR heads when CI head is absent, got %d: %v", len(msg.msgs), msg.msgs)
	}
}

func TestPRObservation_MergeConflictNudgesAgent(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{Fetched: true, URL: "pr1", Mergeability: domain.MergeConflicting}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 || !strings.Contains(msg.msgs[0], "merge conflicts") {
		t.Fatalf("want merge-conflict nudge, got %v", msg.msgs)
	}
}

func TestPRObservation_NudgeIncludesPRIdentity(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{
		Fetched:      true,
		URL:          "https://github.com/o/r/pull/7",
		Number:       7,
		Title:        "Add auth",
		SourceBranch: "feat/x/auth",
		TargetBranch: "feat/x",
		CI:           domain.CIFailing,
		Checks:       []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}},
	}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("want one CI nudge, got %d: %v", len(msg.msgs), msg.msgs)
	}
	got := msg.msgs[0]
	if !strings.Contains(got, `PR #7 "Add auth" (feat/x/auth → feat/x)`) {
		t.Fatalf("nudge missing PR identity: %q", got)
	}
	if !strings.Contains(got, "PR: https://github.com/o/r/pull/7") {
		t.Fatalf("nudge missing PR URL: %q", got)
	}
}

func TestPRObservation_MergedTerminatesWithoutNudge(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{{URL: "pr1", Merged: true}}
	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"]
	if !got.IsTerminated || got.Activity.State != domain.ActivityExited {
		t.Fatalf("merged PR should terminate session, got %+v", got)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("merged PR should not send nudge, got %v", msg.msgs)
	}
}

// A session with one merged PR and one still-open PR must NOT terminate: the
// completion bar is "no open PR remains AND at least one merged".
func TestPRObservation_MergedWithOpenSiblingDoesNotTerminate(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{
		{URL: "pr1", Merged: true},
		{URL: "pr2"},
	}
	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatalf("session with an open sibling PR must stay alive, got %+v", got)
	}
}

// Once the last open PR merges (all PRs now merged), the session terminates.
func TestPRObservation_LastMergeTerminatesSession(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{
		{URL: "pr1", Merged: true},
		{URL: "pr2", Merged: true},
	}
	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr2", Merged: true}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated {
		t.Fatalf("session should terminate once all PRs are merged, got %+v", got)
	}
}

// A closed PR that leaves the session with an open sibling and no merge does not
// terminate; closing the last PR with no merge also does not terminate (nothing
// shipped).
func TestPRObservation_ClosedWithoutMergeDoesNotTerminate(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{{URL: "pr1", Closed: true}}
	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Closed: true}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatalf("a closed-without-merge PR must not terminate the session, got %+v", got)
	}
}

// A PR stacked on an open parent (its target branch is the parent's source
// branch) is exempt from the merge-conflict nudge: conflicts there are expected
// until the parent merges.
func TestPRObservation_StackedChildConflictSuppressed(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{
		{URL: "parent", SourceBranch: "ao/x", TargetBranch: "main"},
		{URL: "child", SourceBranch: "ao/x/auth", TargetBranch: "ao/x"},
	}
	o := ports.PRObservation{Fetched: true, URL: "child", Mergeability: domain.MergeConflicting}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("stacked child conflict should be suppressed, got %v", msg.msgs)
	}
}

// The bottom-of-stack PR (not stacked on any open parent) still gets the
// merge-conflict nudge even when it has open stacked children.
func TestPRObservation_BottomOfStackConflictNudges(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{
		{URL: "parent", SourceBranch: "ao/x", TargetBranch: "main"},
		{URL: "child", SourceBranch: "ao/x/auth", TargetBranch: "ao/x"},
	}
	o := ports.PRObservation{Fetched: true, URL: "parent", Mergeability: domain.MergeConflicting}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 || !strings.Contains(msg.msgs[0], "merge conflicts") {
		t.Fatalf("bottom-of-stack conflict should nudge, got %v", msg.msgs)
	}
}

// TestPRObservation_DedupSurvivesManagerRestart simulates a daemon restart by
// constructing a second Manager over the same store and asserts that an
// identical PR observation does not re-fire the nudge — the dedup signature
// must survive process restart, not just live in the Manager's maps.
func TestPRObservation_DedupSurvivesManagerRestart(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")

	o := ports.PRObservation{
		Fetched: true,
		URL:     "https://github.com/o/r/pull/1",
		CI:      domain.CIFailing,
		Checks:  []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}},
	}

	first := &fakeMessenger{}
	m1 := New(st, first)
	if err := m1.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatalf("first ApplyPRObservation: %v", err)
	}
	if len(first.msgs) != 1 {
		t.Fatalf("first manager: want 1 nudge, got %d", len(first.msgs))
	}
	if got := st.signatures[o.URL]; got == "" {
		t.Fatalf("signature was not persisted; want a non-empty JSON payload for %q", o.URL)
	}

	// Simulate daemon restart: the second Manager has no in-memory state but
	// shares the same store, so it should hydrate seen/attempts from the
	// persisted payload and suppress the re-send.
	second := &fakeMessenger{}
	m2 := New(st, second)
	if err := m2.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatalf("second ApplyPRObservation: %v", err)
	}
	if len(second.msgs) != 0 {
		t.Fatalf("post-restart manager re-nudged on identical observation, got %d msgs: %v", len(second.msgs), second.msgs)
	}

	// And a genuinely new signature (different log tail) still fires — proving
	// the persisted state is per-signature, not a blanket "this PR was nudged".
	o2 := o
	o2.Checks = []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "different boom"}}
	if err := m2.ApplyPRObservation(ctx, "mer-1", o2); err != nil {
		t.Fatalf("third ApplyPRObservation: %v", err)
	}
	if len(second.msgs) != 1 {
		t.Fatalf("new signature should send, got %d msgs", len(second.msgs))
	}
}

func TestPRObservation_DedupPersistsAcrossPRs(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	msg := &fakeMessenger{}
	m := New(st, msg)

	for _, url := range []string{"https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"} {
		o := ports.PRObservation{
			Fetched: true, URL: url, CI: domain.CIFailing,
			Checks: []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}},
		}
		if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
			t.Fatalf("ApplyPRObservation for %s: %v", url, err)
		}
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("distinct PRs should each get one nudge, got %d", len(msg.msgs))
	}
	if _, ok := st.signatures["https://github.com/o/r/pull/1"]; !ok {
		t.Fatal("missing persisted signature for PR 1")
	}
	if _, ok := st.signatures["https://github.com/o/r/pull/2"]; !ok {
		t.Fatal("missing persisted signature for PR 2")
	}
}

func TestApplyReviewResultSendsAndDedupsThroughPRSignature(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	msg := &fakeMessenger{}
	m := New(st, msg)
	result := ReviewResult{
		RunID:          "run-1",
		WorkerID:       "mer-1",
		PRURL:          "https://github.com/o/r/pull/1",
		TargetSHA:      "sha1",
		Verdict:        domain.VerdictChangesRequested,
		Body:           "fix the bug",
		GithubReviewID: "98\x1b[2J765",
	}

	outcome, err := m.ApplyReviewResult(ctx, "mer-1", result)
	if err != nil {
		t.Fatalf("ApplyReviewResult: %v", err)
	}
	if outcome != ReviewDeliverySent || len(msg.msgs) != 1 {
		t.Fatalf("outcome/messages = %q/%v, want sent once", outcome, msg.msgs)
	}
	got := msg.msgs[0]
	for _, want := range []string{"[AO reviewer]", "PR: " + result.PRURL, "Verdict: changes_requested", "Review body:\nfix the bug", "GitHub review: 98[2J765"} {
		if !strings.Contains(got, want) {
			t.Fatalf("AO review nudge missing %q: %q", want, got)
		}
	}
	if strings.Contains(got, "\x1b") {
		t.Fatalf("AO review nudge should sanitize control bytes: %q", got)
	}
	if st.signatures[result.PRURL] == "" {
		t.Fatal("AO review nudge did not persist sendOnce signature")
	}

	outcome, err = m.ApplyReviewResult(ctx, "mer-1", result)
	if err != nil {
		t.Fatalf("repeat ApplyReviewResult: %v", err)
	}
	if outcome != ReviewDeliverySent || len(msg.msgs) != 1 {
		t.Fatalf("repeat should report delivered outcome and suppress duplicate send, outcome=%q msgs=%v", outcome, msg.msgs)
	}

	result.RunID = "run-2"
	result.TargetSHA = "sha2"
	outcome, err = m.ApplyReviewResult(ctx, "mer-1", result)
	if err != nil {
		t.Fatalf("new pass ApplyReviewResult: %v", err)
	}
	if outcome != ReviewDeliverySent || len(msg.msgs) != 2 {
		t.Fatalf("new review pass should send again, outcome=%q msgs=%v", outcome, msg.msgs)
	}
}

func TestApplyReviewResultSuppressedByJITGuardIsNotDelivered(t *testing.T) {
	// The worker is working at ApplyReviewResult's entry guard (read #1) but a
	// permission dialog stores blocked before sendOnce's just-in-time re-read
	// (read #2). The nudge must be SUPPRESSED, and the outcome must be
	// ReviewDeliveryNoop — NOT Sent — so the caller does not stamp the run
	// delivered and the changes-requested feedback re-fires once unblocked.
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	bst := &blockOnNthGetStore{fakeStore: st, id: "mer-1", flipAt: 2}
	msg := &fakeMessenger{}
	m := New(bst, msg)
	result := ReviewResult{
		RunID: "run-1", WorkerID: "mer-1", PRURL: "https://github.com/o/r/pull/1",
		TargetSHA: "sha1", Verdict: domain.VerdictChangesRequested, Body: "fix the bug",
	}

	outcome, err := m.ApplyReviewResult(ctx, "mer-1", result)
	if err != nil {
		t.Fatalf("ApplyReviewResult: %v", err)
	}
	if outcome != ReviewDeliveryNoop {
		t.Fatalf("outcome = %q, want no_op (suppressed nudge must not be stamped delivered)", outcome)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("nudge pasted into a session that went blocked before send: %v", msg.msgs)
	}
	if st.signatures[result.PRURL] != "" {
		t.Fatal("suppressed nudge must not persist a sendOnce signature (it re-fires next observation)")
	}
}

func TestApplyReviewBatchSendsCombinedAndDedups(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	msg := &fakeMessenger{}
	m := New(st, msg)
	results := []ReviewResult{
		{RunID: "run-2", BatchID: "batch-1", WorkerID: "mer-1", PRURL: "https://github.com/o/r/pull/2", TargetSHA: "sha2", Verdict: domain.VerdictChangesRequested, Body: "fix tests", GithubReviewID: "102"},
		{RunID: "run-1", BatchID: "batch-1", WorkerID: "mer-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1", Verdict: domain.VerdictChangesRequested, Body: "fix auth", GithubReviewID: "101"},
	}

	outcome, err := m.ApplyReviewBatch(ctx, "mer-1", "batch-1", results)
	if err != nil {
		t.Fatalf("ApplyReviewBatch: %v", err)
	}
	if outcome != ReviewDeliverySent || len(msg.msgs) != 1 {
		t.Fatalf("outcome/messages = %q/%v, want sent once", outcome, msg.msgs)
	}
	got := msg.msgs[0]
	for _, want := range []string{
		"submitted 2 review(s) requesting changes",
		"PR: https://github.com/o/r/pull/1",
		"GitHub review: 101",
		"Review body:\nfix auth",
		"PR: https://github.com/o/r/pull/2",
		"GitHub review: 102",
		"Review body:\nfix tests",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("batch nudge missing %q: %q", want, got)
		}
	}
	if st.signatures["https://github.com/o/r/pull/1"] == "" {
		t.Fatal("batch nudge did not persist signature on anchor PR")
	}

	outcome, err = m.ApplyReviewBatch(ctx, "mer-1", "batch-1", results)
	if err != nil {
		t.Fatalf("repeat ApplyReviewBatch: %v", err)
	}
	if outcome != ReviewDeliverySent || len(msg.msgs) != 1 {
		t.Fatalf("repeat should suppress duplicate send, outcome=%q msgs=%v", outcome, msg.msgs)
	}
}

func TestApplyReviewBatchNoopsWithoutDeliverableResults(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	msg := &fakeMessenger{}
	m := New(st, msg)

	outcome, err := m.ApplyReviewBatch(ctx, "mer-1", "batch-1", nil)
	if err != nil {
		t.Fatalf("ApplyReviewBatch: %v", err)
	}
	if outcome != ReviewDeliveryNoop || len(msg.msgs) != 0 || st.signatureWrites != 0 {
		t.Fatalf("empty batch should no-op, outcome=%q msgs=%v signatureWrites=%d", outcome, msg.msgs, st.signatureWrites)
	}
}

func TestApplyReviewResultNoopsWhenIrrelevant(t *testing.T) {
	deliveredAt := time.Unix(100, 0).UTC()
	tests := []struct {
		name   string
		result ReviewResult
		rec    domain.SessionRecord
	}{
		{
			name:   "approved",
			result: ReviewResult{RunID: "run-1", PRURL: "pr1", Verdict: domain.VerdictApproved},
			rec:    working("mer-1"),
		},
		{
			name:   "already delivered",
			result: ReviewResult{RunID: "run-1", PRURL: "pr1", Verdict: domain.VerdictChangesRequested, DeliveredAt: &deliveredAt},
			rec:    working("mer-1"),
		},
		{
			name:   "terminated worker",
			result: ReviewResult{RunID: "run-1", PRURL: "pr1", Verdict: domain.VerdictChangesRequested},
			rec:    func() domain.SessionRecord { r := working("mer-1"); r.IsTerminated = true; return r }(),
		},
		{
			name:   "worker waiting input",
			result: ReviewResult{RunID: "run-1", PRURL: "pr1", Verdict: domain.VerdictChangesRequested},
			rec:    domain.SessionRecord{ID: "mer-1", Activity: domain.Activity{State: domain.ActivityWaitingInput}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, st, msg := newManager()
			st.sessions["mer-1"] = tt.rec
			outcome, err := m.ApplyReviewResult(ctx, "mer-1", tt.result)
			if err != nil {
				t.Fatalf("ApplyReviewResult: %v", err)
			}
			if outcome != ReviewDeliveryNoop || len(msg.msgs) != 0 || st.signatureWrites != 0 {
				t.Fatalf("irrelevant result should no-op, outcome=%q msgs=%v signatureWrites=%d", outcome, msg.msgs, st.signatureWrites)
			}
		})
	}
}

func TestApplyTrackerFacts_TerminalStateMarksTerminated(t *testing.T) {
	for _, state := range []domain.NormalizedIssueState{domain.IssueDone, domain.IssueCancelled} {
		t.Run(string(state), func(t *testing.T) {
			m, st, msg := newManager()
			st.sessions["mer-1"] = working("mer-1")
			o := ports.TrackerObservation{
				Fetched: true,
				Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: state},
			}
			if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
				t.Fatalf("ApplyTrackerFacts: %v", err)
			}
			got := st.sessions["mer-1"]
			if !got.IsTerminated || got.Activity.State != domain.ActivityExited {
				t.Fatalf("want terminated/exited for state %q, got %+v", state, got)
			}
			if len(msg.msgs) != 0 {
				t.Fatalf("terminal state should not nudge, got %v", msg.msgs)
			}
		})
	}
}

func TestApplyTrackerFacts_AssigneeChangedIsLogOnly(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	before := st.sessions["mer-1"]
	o := ports.TrackerObservation{
		Fetched: true,
		Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: domain.IssueOpen, Assignee: "someone-else"},
		Changed: ports.TrackerChanged{Assignee: true},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("ApplyTrackerFacts: %v", err)
	}
	if !reflect.DeepEqual(st.sessions["mer-1"], before) {
		t.Fatalf("assignee-only change must not mutate the session row, got %+v", st.sessions["mer-1"])
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("assignee-only change must not nudge, got %v", msg.msgs)
	}
}

func TestApplyTrackerFacts_NewBotCommentNudges(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.TrackerObservation{
		Fetched: true,
		Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: domain.IssueOpen},
		Comments: []ports.TrackerCommentObservation{
			{ID: "human-1", Author: "alice", Body: "human chime-in, must NOT nudge", IsBot: false},
			{ID: "bot-1", Author: "ci-bot[bot]", Body: "please rerun the migration", IsBot: true},
		},
		Changed: ports.TrackerChanged{Comments: true},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("ApplyTrackerFacts: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("want one bot-mention nudge, got %d: %v", len(msg.msgs), msg.msgs)
	}
	if !strings.Contains(msg.msgs[0], "please rerun the migration") {
		t.Fatalf("nudge should include the bot comment body, got %q", msg.msgs[0])
	}
	if strings.Contains(msg.msgs[0], "human chime-in") {
		t.Fatalf("nudge must not include human comments, got %q", msg.msgs[0])
	}
}

func TestApplyTrackerFacts_NudgeSuppressedOnRepeat(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.TrackerObservation{
		Fetched: true,
		Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: domain.IssueOpen},
		Comments: []ports.TrackerCommentObservation{
			{ID: "bot-1", Author: "ci-bot[bot]", Body: "please rerun the migration", IsBot: true},
		},
		Changed: ports.TrackerChanged{Comments: true},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("first ApplyTrackerFacts: %v", err)
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("second ApplyTrackerFacts: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("repeat observation must dedup; got %d nudges: %v", len(msg.msgs), msg.msgs)
	}

	// A genuinely new bot comment still fires.
	o.Comments = append(o.Comments, ports.TrackerCommentObservation{ID: "bot-2", Author: "ci-bot[bot]", Body: "now check the seed", IsBot: true})
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("third ApplyTrackerFacts: %v", err)
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("new bot comment id should re-fire, got %d: %v", len(msg.msgs), msg.msgs)
	}
}

func TestApplyTrackerFacts_BotCommentWithEmptyIDIsIgnored(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	// Bot comment lacks an ID — without one we cannot dedup, and the
	// zero-value signature collides with m.react.seen's empty default and
	// would silently suppress every future nudge for this issue. The
	// reducer must skip it entirely.
	o := ports.TrackerObservation{
		Fetched: true,
		Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: domain.IssueOpen},
		Comments: []ports.TrackerCommentObservation{
			{ID: "", Author: "ci-bot[bot]", Body: "no id, must be skipped", IsBot: true},
		},
		Changed: ports.TrackerChanged{Comments: true},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("ApplyTrackerFacts: %v", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("bot comment with empty ID must not nudge, got %v", msg.msgs)
	}
	// A subsequent, properly-formed bot comment must still nudge — the
	// earlier empty-ID entry must not have polluted the dedup signature.
	o.Comments = []ports.TrackerCommentObservation{
		{ID: "bot-1", Author: "ci-bot[bot]", Body: "now with an id", IsBot: true},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("second ApplyTrackerFacts: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("follow-up bot comment with real ID should nudge, got %d: %v", len(msg.msgs), msg.msgs)
	}
}

func TestApplyTrackerFacts_NotFetchedIsNoop(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	before := st.sessions["mer-1"]
	if err := m.ApplyTrackerFacts(ctx, "mer-1", ports.TrackerObservation{Fetched: false}); err != nil {
		t.Fatalf("ApplyTrackerFacts: %v", err)
	}
	if !reflect.DeepEqual(st.sessions["mer-1"], before) {
		t.Fatalf("not-fetched observation must not mutate state")
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("not-fetched observation must not nudge")
	}
}

func TestApplyTrackerFacts_TerminatedSessionDoesNotRefireOrNudge(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", IsTerminated: true, Activity: domain.Activity{State: domain.ActivityExited}}
	o := ports.TrackerObservation{
		Fetched: true,
		Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: domain.IssueOpen},
		Comments: []ports.TrackerCommentObservation{
			{ID: "bot-1", Body: "x", IsBot: true},
		},
		Changed: ports.TrackerChanged{Comments: true},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatalf("ApplyTrackerFacts: %v", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("terminated session must not receive nudges, got %v", msg.msgs)
	}
}

func TestPRObservation_RetriesAfterMessengerFailure(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	o := ports.PRObservation{Fetched: true, URL: "pr1", Mergeability: domain.MergeConflicting}
	msg.err = errors.New("temporary send failure")
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err == nil {
		t.Fatal("want send error")
	}
	msg.err = nil
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("want retry to send once, got %v", msg.msgs)
	}
}

func TestActivity_FirstSignalStampsReceipt(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()}}
	// A same-state repeat (idle on an idle-seeded row) must still write: the
	// receipt itself is the durable fact that clears no_signal.
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityIdle}); err != nil {
		t.Fatal(err)
	}
	got := st.sessions["mer-1"]
	if got.FirstSignalAt.IsZero() {
		t.Fatalf("first signal not stamped: %+v", got)
	}
	stamped := got.FirstSignalAt
	// Later signals must not move the receipt.
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Timestamp: time.Now().Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.FirstSignalAt.Equal(stamped) {
		t.Fatalf("first signal moved: %v -> %v", stamped, got.FirstSignalAt)
	}
}

func TestActivity_SameStateRepeatAfterReceiptIsNoOp(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.FirstSignalAt = time.Now()
	st.sessions["mer-1"] = rec
	before := st.sessions["mer-1"]
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityActive}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st.sessions["mer-1"], before) {
		t.Fatalf("same-state repeat after receipt must not rewrite: %+v", st.sessions["mer-1"])
	}
}

func TestMarkSpawnedClearsFirstSignal(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.FirstSignalAt = time.Now().Add(-time.Hour)
	st.sessions["mer-1"] = rec
	if err := m.MarkSpawned(ctx, "mer-1", domain.SessionMetadata{}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.FirstSignalAt.IsZero() {
		t.Fatalf("spawn/restore must clear the receipt, got %+v", got)
	}
}

type fakeNotificationSink struct {
	mu sync.Mutex
	// intents records deliveries that succeeded; attempts counts every Notify
	// call including failures. A failed emit is a real attempt (the caller must
	// not settle its dedupe signature) but not a delivery, so the two are
	// tracked separately.
	intents  []ports.NotificationIntent
	attempts int
	err      error
}

func (f *fakeNotificationSink) Notify(_ context.Context, intent ports.NotificationIntent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts++
	if f.err != nil {
		return f.err
	}
	f.intents = append(f.intents, intent)
	return nil
}

func TestActivity_WaitingInputTransitionEmitsNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "checkout-flow", Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1", len(sink.intents))
	}
	intent := sink.intents[0]
	if intent.Type != domain.NotificationNeedsInput || intent.SessionID != "mer-1" || intent.ProjectID != "mer" || intent.SessionDisplayName != "checkout-flow" {
		t.Fatalf("intent = %+v", intent)
	}
}

func TestActivity_OrchestratorWaitingInputTransitionDoesNotEmitNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-orch"] = domain.SessionRecord{ID: "mer-orch", ProjectID: "mer", Kind: domain.KindOrchestrator, DisplayName: "mer-orchestrator", Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "mer-orch", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := m.ApplyActivitySignal(ctx, "mer-orch", ports.ActivitySignal{Valid: true, State: domain.ActivityActive}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := m.ApplyActivitySignal(ctx, "mer-orch", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("routine orchestrator waiting_input emitted %+v", sink.intents)
	}
}

func TestActivity_PrimeWaitingInputTransitionDoesNotEmitNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["ao-prime"] = domain.SessionRecord{ID: "ao-prime", ProjectID: "ao", Kind: domain.KindPrime, DisplayName: "ao Prime", Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "ao-prime", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := m.ApplyActivitySignal(ctx, "ao-prime", ports.ActivitySignal{Valid: true, State: domain.ActivityActive}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := m.ApplyActivitySignal(ctx, "ao-prime", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("routine prime waiting_input emitted %+v", sink.intents)
	}
}

func TestActivity_WaitingInputSameStateDoesNotEmitNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Now()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Activity: domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: now}, FirstSignalAt: now}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("same-state waiting_input emitted %+v", sink.intents)
	}
}

func TestActivity_BlockedTransitionEmitsNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", DisplayName: "checkout-flow", Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1 (blocked is a needs-input entry)", len(sink.intents))
	}
	if sink.intents[0].Type != domain.NotificationNeedsInput {
		t.Fatalf("intent type = %q, want needs_input", sink.intents[0].Type)
	}
}

func TestActivity_OrchestratorWaitingInputToBlockedEmitsNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-orch"] = domain.SessionRecord{ID: "mer-orch", ProjectID: "mer", Kind: domain.KindOrchestrator, DisplayName: "mer-orchestrator", Activity: domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "mer-orch", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1", len(sink.intents))
	}
	if sink.intents[0].Type != domain.NotificationNeedsInput || sink.intents[0].SessionID != "mer-orch" {
		t.Fatalf("intent = %+v", sink.intents[0])
	}
}

func TestActivity_PrimeWaitingInputToBlockedEmitsNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["ao-prime"] = domain.SessionRecord{ID: "ao-prime", ProjectID: "ao", Kind: domain.KindPrime, DisplayName: "ao Prime", Activity: domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "ao-prime", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1", len(sink.intents))
	}
	if sink.intents[0].Type != domain.NotificationNeedsInput || sink.intents[0].SessionID != "ao-prime" {
		t.Fatalf("intent = %+v", sink.intents[0])
	}
}

func TestActivity_OrchestratorDirectBlockedTransitionEmitsNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-orch"] = domain.SessionRecord{ID: "mer-orch", ProjectID: "mer", Kind: domain.KindOrchestrator, DisplayName: "mer-orchestrator", Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "mer-orch", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1", len(sink.intents))
	}
	if sink.intents[0].Type != domain.NotificationNeedsInput || sink.intents[0].SessionID != "mer-orch" {
		t.Fatalf("intent = %+v", sink.intents[0])
	}
}

func TestActivity_OrchestratorRepeatedBlockedDoesNotReNotify(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:            "mer-orch",
		ProjectID:     "mer",
		Kind:          domain.KindOrchestrator,
		DisplayName:   "mer-orchestrator",
		Activity:      domain.Activity{State: domain.ActivityBlocked, LastActivityAt: now.Add(-time.Minute)},
		FirstSignalAt: now.Add(-time.Minute),
		Metadata:      domain.SessionMetadata{PendingDecision: &domain.PendingDecision{Kind: domain.DecisionKindPermission}},
	}

	if err := m.ApplyActivitySignal(ctx, "mer-orch", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("repeat blocked emitted notification: %+v", sink.intents)
	}
}

func TestActivity_WaitingInputToBlockedDoesNotReNotify(t *testing.T) {
	// waiting_input -> blocked is an in-family escalation: the user was already
	// pinged once for this pause, so no second notification and no telemetry
	// entry/exit pair.
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	tele := &telemetrySink{}
	m := New(st, nil, WithNotificationSink(sink), WithTelemetry(tele))
	now := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, Activity: domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: now.Add(-time.Minute)}, FirstSignalAt: now.Add(-time.Minute)}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("in-family escalation emitted notification: %+v", sink.intents)
	}
	if len(tele.events) != 0 {
		t.Fatalf("in-family escalation emitted telemetry: %+v", tele.events)
	}
}

func TestActivity_BlockedEntryAndExitEmitTelemetry(t *testing.T) {
	st := newFakeStore()
	sink := &telemetrySink{}
	m := New(st, nil, WithTelemetry(sink))
	now := time.Unix(100, 0).UTC()
	m.clock = func() time.Time { return now }
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Minute)},
	}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityBlocked, Timestamp: now}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Timestamp: now}); err != nil {
		t.Fatal(err)
	}

	if len(sink.events) != 2 {
		t.Fatalf("events = %#v, want entered/exited", sink.events)
	}
	if sink.events[0].Name != "ao.session.waiting_input_entered" || sink.events[1].Name != "ao.session.waiting_input_exited" {
		t.Fatalf("event names = %#v (family events keep the waiting_input_* names)", []string{sink.events[0].Name, sink.events[1].Name})
	}
	if got := sink.events[0].Payload["state"]; got != "blocked" {
		t.Fatalf("entered payload state = %#v, want blocked", got)
	}
}

func TestSCMObservation_ReadyToMergeSuppressedWhileBlocked(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	rec := working("mer-1")
	rec.Activity.State = domain.ActivityBlocked
	st.sessions["mer-1"] = rec
	obs := ports.SCMObservation{
		Fetched:      true,
		PR:           ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1},
		CI:           ports.SCMCIObservation{Summary: string(domain.CIPassing)},
		Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)},
	}
	if err := m.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("blocked session emitted ready notification: %+v", sink.intents)
	}
}

// blockOnNthGetStore wraps fakeStore and flips a session to ActivityBlocked on
// the Nth GetSession call, reproducing the reactions TOCTOU: the handler's
// entry guard (1st read) sees the session working, but a permission hook stores
// blocked before sendOnce's just-in-time re-read (2nd read).
type blockOnNthGetStore struct {
	*fakeStore
	id     domain.SessionID
	reads  int
	flipAt int
}

func (s *blockOnNthGetStore) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	s.reads++
	if s.reads == s.flipAt {
		if rec, ok := s.sessions[s.id]; ok {
			rec.Activity.State = domain.ActivityBlocked
			s.sessions[s.id] = rec
		}
	}
	return s.fakeStore.GetSession(ctx, id)
}

func TestSendOnce_NoNudgeWhenBlockedAppearsBeforeSend(t *testing.T) {
	// The entry guard in ApplyPRObservation reads the session working (read #1);
	// a permission dialog then stores blocked before sendOnce's just-in-time
	// re-read (read #2), which must suppress the paste+Enter into the dialog.
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	bst := &blockOnNthGetStore{fakeStore: st, id: "mer-1", flipAt: 2}
	msg := &fakeMessenger{}
	m := New(bst, msg)
	o := ports.PRObservation{Fetched: true, URL: "pr1", CI: domain.CIFailing, Checks: []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("nudge sent into a session that went blocked before send: %v", msg.msgs)
	}
}

func TestPRObservation_NudgesSuppressedWhileBlocked(t *testing.T) {
	// A blocked session must not receive automated CI/review nudges: injected
	// text could interact with the pending permission dialog.
	m, st, msg := newManager()
	rec := working("mer-1")
	rec.Activity.State = domain.ActivityBlocked
	st.sessions["mer-1"] = rec
	o := ports.PRObservation{Fetched: true, URL: "pr1", CI: domain.CIFailing, Checks: []ports.PRCheckObservation{{Name: "build", CommitHash: "c1", Status: domain.PRCheckFailed, LogTail: "boom"}}}
	if err := m.ApplyPRObservation(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("blocked session got nudged: %v", msg.msgs)
	}
}

func TestActivity_TerminatedSessionDoesNotEmitNotification(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", IsTerminated: true, Activity: domain.Activity{State: domain.ActivityExited}}

	if err := m.ApplyActivitySignal(ctx, "mer-1", ports.ActivitySignal{Valid: true, State: domain.ActivityWaitingInput}); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("terminated session emitted %+v", sink.intents)
	}
}

func TestSCMObservation_Notifications(t *testing.T) {
	for _, tc := range []struct {
		name             string
		obs              ports.SCMObservation
		want             domain.NotificationType
		wantSensitive    bool
		wantChangedPaths []string
	}{
		{
			name:             "ready sensitive",
			obs:              ports.SCMObservation{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1, Title: "checkout", ChangedPaths: []string{"backend/internal/lifecycle/reactions.go", "ops/ao-slack-notifier.mjs"}}, CI: ports.SCMCIObservation{Summary: string(domain.CIPassing)}, Review: ports.SCMReviewObservation{Decision: string(domain.ReviewApproved)}, Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)}},
			want:             domain.NotificationReadyToMerge,
			wantSensitive:    true,
			wantChangedPaths: []string{"backend/internal/lifecycle/reactions.go", "ops/ao-slack-notifier.mjs"},
		},
		{
			name: "merged",
			obs:  ports.SCMObservation{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/2", Number: 2, Merged: true}},
			want: domain.NotificationPRMerged,
		},
		{
			name: "closed",
			obs:  ports.SCMObservation{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/3", Number: 3, Closed: true}},
			want: domain.NotificationPRClosedUnmerged,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			sink := &fakeNotificationSink{}
			m := New(st, nil, WithNotificationSink(sink))
			st.sessions["mer-1"] = working("mer-1")
			if err := m.ApplySCMObservation(ctx, "mer-1", tc.obs); err != nil {
				t.Fatal(err)
			}
			if len(sink.intents) != 1 {
				t.Fatalf("intents = %d, want 1", len(sink.intents))
			}
			if got := sink.intents[0]; got.Type != tc.want || got.PRURL != tc.obs.PR.URL || got.PRNumber != tc.obs.PR.Number {
				t.Fatalf("intent = %+v, want type %s", got, tc.want)
			}
			if got := sink.intents[0]; got.Sensitive != tc.wantSensitive || !reflect.DeepEqual(got.ChangedPaths, tc.wantChangedPaths) {
				t.Fatalf("intent metadata = sensitive:%v paths:%#v, want sensitive:%v paths:%#v", got.Sensitive, got.ChangedPaths, tc.wantSensitive, tc.wantChangedPaths)
			}
		})
	}
}

func TestSCMObservation_NotReadyWhenCIOrReviewBlocks(t *testing.T) {
	for _, obs := range []ports.SCMObservation{
		{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1}, CI: ports.SCMCIObservation{Summary: string(domain.CIFailing)}, Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)}},
		{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1}, CI: ports.SCMCIObservation{Summary: string(domain.CIPending)}, Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)}},
		{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1}, CI: ports.SCMCIObservation{Summary: string(domain.CIUnknown)}, Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)}},
		{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1}, Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)}},
		{Fetched: true, PR: ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1}, CI: ports.SCMCIObservation{Summary: string(domain.CIPassing)}, Review: ports.SCMReviewObservation{Decision: string(domain.ReviewChangesRequest)}, Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)}},
	} {
		st := newFakeStore()
		sink := &fakeNotificationSink{}
		m := New(st, nil, WithNotificationSink(sink))
		st.sessions["mer-1"] = working("mer-1")
		if err := m.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
			t.Fatal(err)
		}
		if len(sink.intents) != 0 {
			t.Fatalf("blocked PR emitted %+v", sink.intents)
		}
	}
}

func TestSCMObservation_ReadyToMergeSuppressedWhileWaitingInput(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	rec := working("mer-1")
	rec.Activity.State = domain.ActivityWaitingInput
	st.sessions["mer-1"] = rec
	obs := ports.SCMObservation{
		Fetched:      true,
		PR:           ports.SCMPRObservation{URL: "https://github.com/o/r/pull/1", Number: 1},
		CI:           ports.SCMCIObservation{Summary: string(domain.CIPassing)},
		Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)},
	}
	if err := m.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 0 {
		t.Fatalf("waiting-input session emitted ready notification: %+v", sink.intents)
	}
}

func readyObs(url, headSHA string) ports.SCMObservation {
	return ports.SCMObservation{
		Fetched:      true,
		PR:           ports.SCMPRObservation{URL: url, Number: 1, HeadSHA: headSHA},
		CI:           ports.SCMCIObservation{Summary: string(domain.CIPassing)},
		Review:       ports.SCMReviewObservation{Decision: string(domain.ReviewApproved)},
		Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable)},
	}
}

// A stable ready-to-merge PR observed repeatedly emits exactly one notification
// (issue #190): re-observations of the same (type, head SHA, sensitive) signature
// must not re-notify.
func TestSCMObservation_ReadyToMergeEmitsOncePerSignature(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")
	obs := readyObs("https://github.com/o/r/pull/1", "sha-1")
	for i := 0; i < 5; i++ {
		if err := m.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
			t.Fatal(err)
		}
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1 (dedupe on unchanged signature)", len(sink.intents))
	}
}

// A new head SHA is a real state change and must re-notify.
func TestSCMObservation_ReadyToMergeReNotifiesOnNewHead(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")
	if err := m.ApplySCMObservation(ctx, "mer-1", readyObs("https://github.com/o/r/pull/1", "sha-1")); err != nil {
		t.Fatal(err)
	}
	if err := m.ApplySCMObservation(ctx, "mer-1", readyObs("https://github.com/o/r/pull/1", "sha-2")); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 2 {
		t.Fatalf("intents = %d, want 2 (new head SHA re-notifies)", len(sink.intents))
	}
}

// The dedupe signature is persisted (pr.last_nudge_signature), so a fresh
// Manager — modeling a daemon restart — does not re-fire the same ready state.
func TestSCMObservation_ReadyToMergeDedupeSurvivesRestart(t *testing.T) {
	st := newFakeStore()
	obs := readyObs("https://github.com/o/r/pull/1", "sha-1")

	sink1 := &fakeNotificationSink{}
	m1 := New(st, nil, WithNotificationSink(sink1))
	st.sessions["mer-1"] = working("mer-1")
	if err := m1.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
		t.Fatal(err)
	}
	if len(sink1.intents) != 1 {
		t.Fatalf("pre-restart intents = %d, want 1", len(sink1.intents))
	}

	// New Manager over the same store: the persisted signature must suppress the
	// re-derived notification on the first post-restart poll.
	sink2 := &fakeNotificationSink{}
	m2 := New(st, nil, WithNotificationSink(sink2))
	if err := m2.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
		t.Fatal(err)
	}
	if len(sink2.intents) != 0 {
		t.Fatalf("post-restart intents = %d, want 0 (persisted dedupe)", len(sink2.intents))
	}
}

// A sensitive-flag flip is part of the signature and must re-notify (the
// operator escalation changes from a plain post to an @mention).
func TestSCMObservation_ReadyToMergeReNotifiesOnSensitiveChange(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")

	plain := readyObs("https://github.com/o/r/pull/1", "sha-1")
	if err := m.ApplySCMObservation(ctx, "mer-1", plain); err != nil {
		t.Fatal(err)
	}
	sensitive := readyObs("https://github.com/o/r/pull/1", "sha-1")
	sensitive.PR.ChangedPaths = []string{"backend/internal/lifecycle/reactions.go"}
	if err := m.ApplySCMObservation(ctx, "mer-1", sensitive); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 2 {
		t.Fatalf("intents = %d, want 2 (sensitive flip re-notifies)", len(sink.intents))
	}
	if !sink.intents[1].Sensitive {
		t.Fatalf("second intent should be sensitive, got %+v", sink.intents[1])
	}
}

// A ready PR that goes unready (CI red) and later ready again on the SAME head
// must re-notify: the non-ready observation clears the persisted signature so
// the return-to-ready is a fresh transition, not a suppressed duplicate (#190
// review finding 1b).
func TestSCMObservation_ReadyToMergeReNotifiesAfterUnreadyOnSameHead(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")
	url := "https://github.com/o/r/pull/1"

	if err := m.ApplySCMObservation(ctx, "mer-1", readyObs(url, "sha-1")); err != nil {
		t.Fatal(err)
	}
	// CI flips red on the same head: no notification, and the signature is cleared.
	unready := readyObs(url, "sha-1")
	unready.CI = ports.SCMCIObservation{Summary: string(domain.CIFailing)}
	if err := m.ApplySCMObservation(ctx, "mer-1", unready); err != nil {
		t.Fatal(err)
	}
	// CI goes green again on the same head: this is a real re-transition to ready.
	if err := m.ApplySCMObservation(ctx, "mer-1", readyObs(url, "sha-1")); err != nil {
		t.Fatal(err)
	}
	if len(sink.intents) != 2 {
		t.Fatalf("intents = %d, want 2 (unready then re-ready on same head re-notifies)", len(sink.intents))
	}
}

// A persist failure must not swallow the notification (it is emitted first) and
// must not permanently suppress future notifications: because the persist failed
// the signature is not durably recorded, so a fresh Manager (restart) re-fires
// rather than silently dropping the state (#190 review finding 1a).
func TestSCMObservation_PersistFailureStillEmitsAndDoesNotPermanentlySuppress(t *testing.T) {
	st := newFakeStore()
	st.signatureWriteErr = errors.New("boom")
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")
	obs := readyObs("https://github.com/o/r/pull/1", "sha-1")

	// The emit happens before the persist write, so the error surfaces but the
	// notification was already produced.
	if err := m.ApplySCMObservation(ctx, "mer-1", obs); err == nil {
		t.Fatal("want persist error to surface")
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1 (emit before persist)", len(sink.intents))
	}

	// Restart: the failed persist left nothing durable, so the re-derived ready
	// state fires again rather than being lost forever.
	st.signatureWriteErr = nil
	sink2 := &fakeNotificationSink{}
	m2 := New(st, nil, WithNotificationSink(sink2))
	if err := m2.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
		t.Fatal(err)
	}
	if len(sink2.intents) != 1 {
		t.Fatalf("post-restart intents = %d, want 1 (persist failure not permanently suppressing)", len(sink2.intents))
	}
}

// A failed notification-sink write must NOT record the dedupe signature: the
// notification never reached storage, so a later observation of the same state
// must re-attempt it rather than treating it as delivered (#190 review cycle 2,
// finding 1a).
func TestSCMObservation_EmitFailureDoesNotRecordSignature(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{err: errors.New("sink down")}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")
	obs := readyObs("https://github.com/o/r/pull/1", "sha-1")

	if err := m.ApplySCMObservation(ctx, "mer-1", obs); err == nil {
		t.Fatal("want emit error to surface")
	}
	if sink.attempts != 1 {
		t.Fatalf("attempts = %d, want 1", sink.attempts)
	}
	if st.signatureWrites != 0 {
		t.Fatalf("signature persisted despite emit failure: writes=%d", st.signatureWrites)
	}

	// Sink recovers: the same state must re-emit because nothing was recorded.
	sink.err = nil
	if err := m.ApplySCMObservation(ctx, "mer-1", obs); err != nil {
		t.Fatal(err)
	}
	if sink.attempts != 2 {
		t.Fatalf("attempts = %d, want 2 (retry after sink recovery)", sink.attempts)
	}
	if st.signatureWrites != 1 {
		t.Fatalf("signature writes = %d, want 1 (persisted only after successful emit)", st.signatureWrites)
	}
}

// forgetNotificationSignature must not drop the in-memory entry when the durable
// deletion fails: otherwise a later non-ready poll would short-circuit on a
// missing key and leave the stale signature on disk to suppress a legitimate
// return-to-ready after a restart (#190 review cycle 2, finding 1b).
func TestSCMObservation_ForgetSignaturePersistFailureRestoresEntry(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	st.sessions["mer-1"] = working("mer-1")
	url := "https://github.com/o/r/pull/1"

	// Establish a ready signature.
	if err := m.ApplySCMObservation(ctx, "mer-1", readyObs(url, "sha-1")); err != nil {
		t.Fatal(err)
	}

	// CI red on the same head with a failing persist: the durable deletion fails.
	st.signatureWriteErr = errors.New("boom")
	unready := readyObs(url, "sha-1")
	unready.CI = ports.SCMCIObservation{Summary: string(domain.CIFailing)}
	if err := m.ApplySCMObservation(ctx, "mer-1", unready); err == nil {
		t.Fatal("want persist error to surface")
	}

	// Persist recovers; a second non-ready poll must retry the durable deletion
	// (the in-memory entry was restored, so it is not short-circuited).
	st.signatureWriteErr = nil
	if err := m.ApplySCMObservation(ctx, "mer-1", unready); err != nil {
		t.Fatal(err)
	}
	sig, err := st.GetPRLastNudgeSignature(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sig, "notify:"+url) {
		t.Fatalf("stale notify signature still persisted after retry: %q", sig)
	}
}
