package chat_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// These run against a real SQLite store rather than a mock, because the point is
// that provider events actually land as durable rows in the right order — which a
// mock store cannot demonstrate.

const (
	testProject = domain.ProjectID("p1")
	testSession = domain.SessionID("p1-1")
)

func openStore(t *testing.T) *sqlite.Store {
	t.Helper()
	dir := t.TempDir()
	st := sqlitetest.MustOpenAt(t, dir)

	ctx := context.Background()
	if err := st.UpsertProject(ctx, domain.ProjectRecord{
		ID:           string(testProject),
		Path:         dir,
		RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := st.CreateSession(ctx, domain.SessionRecord{
		ID:        testSession,
		ProjectID: testProject,
		Kind:      domain.KindOrchestrator,
		Harness:   domain.HarnessCodex,
		Mode:      domain.SessionModeChat,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	return st
}

/* ---- a fake conversation the controller can drive ---------------------- */

type fakeConversation struct {
	events chan ports.ChatEvent

	mu        sync.Mutex
	sent      []ports.ChatUserMessage
	resolved  map[string]ports.ChatDecision
	turnSeq   int
	sendErr   error
	closeOnce sync.Once
}

type nativeHistoryConversation struct {
	*fakeConversation
	events []ports.ChatEvent
	err    error
}

type blockingHistoryConversation struct {
	*fakeConversation
	started chan struct{}
	release chan struct{}
}

func (c *blockingHistoryConversation) ReadHistory(ctx context.Context) ([]ports.ChatEvent, error) {
	close(c.started)
	select {
	case <-c.release:
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *nativeHistoryConversation) ReadHistory(context.Context) ([]ports.ChatEvent, error) {
	return c.events, c.err
}

type deferredConversation struct {
	*fakeConversation
	start func(string) error
}

type stuckConversation struct {
	*fakeConversation
	closeErr error
}

func (s *stuckConversation) Close() error { return s.closeErr }

func (f *deferredConversation) StartDeferredTurn(providerTurnID string) error {
	return f.start(providerTurnID)
}

func (f *deferredConversation) DiscardDeferredTurn(string) {}

func newFakeConversation() *fakeConversation {
	return &fakeConversation{
		events:   make(chan ports.ChatEvent, 64),
		resolved: map[string]ports.ChatDecision{},
	}
}

func (f *fakeConversation) ProviderConversationID() string       { return "thread-1" }
func (f *fakeConversation) Capabilities() ports.ChatCapabilities { return productionCaps() }
func (f *fakeConversation) Events() <-chan ports.ChatEvent       { return f.events }

func (f *fakeConversation) SendTurn(_ context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return ports.ChatTurnRef{}, f.sendErr
	}
	f.sent = append(f.sent, msg)
	f.turnSeq++
	return ports.ChatTurnRef{ProviderTurnID: fmt.Sprintf("provider-turn-%d", f.turnSeq)}, nil
}

// sentTexts is what actually reached the provider, in order. Queuing is only real
// if a message the user typed mid-turn is absent from this until the turn ends.
func (f *fakeConversation) sentTexts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	texts := make([]string, 0, len(f.sent))
	for _, msg := range f.sent {
		texts = append(texts, msg.Text)
	}
	return texts
}

func (f *fakeConversation) Interrupt(context.Context, string) error { return nil }

func (f *fakeConversation) ResolveRequest(_ context.Context, id string, d ports.ChatDecision) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resolved[id] = d
	return nil
}

func (f *fakeConversation) Close() error {
	f.closeOnce.Do(func() { close(f.events) })
	return nil
}

func (f *fakeConversation) emit(events ...ports.ChatEvent) {
	for _, event := range events {
		f.events <- event
	}
}

func (f *fakeConversation) decisionFor(id string) (ports.ChatDecision, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.resolved[id]
	return d, ok
}

// fakeDriver hands back whatever conversation double the test supplied, so a
// scenario can replace how the provider ANSWERS without reimplementing how it
// streams.
type fakeDriver struct {
	conv      ports.ChatConversation
	startCfg  *ports.ChatStartConfig
	resumeCfg *ports.ChatResumeConfig
}

func (d fakeDriver) Harness() domain.AgentHarness { return domain.HarnessCodex }
func (d fakeDriver) Probe(context.Context) (ports.ChatCapabilities, error) {
	return productionCaps(), nil
}
func (d fakeDriver) Start(_ context.Context, cfg ports.ChatStartConfig) (ports.ChatConversation, error) {
	if d.startCfg != nil {
		*d.startCfg = cfg
	}
	return d.conv, nil
}
func (d fakeDriver) Resume(_ context.Context, cfg ports.ChatResumeConfig) (ports.ChatConversation, error) {
	if d.resumeCfg != nil {
		*d.resumeCfg = cfg
	}
	return d.conv, nil
}

type fakeRegistry struct{ driver ports.ChatDriver }

func (r fakeRegistry) Driver(domain.AgentHarness) (ports.ChatDriver, error) { return r.driver, nil }
func (r fakeRegistry) SupportsChat(domain.AgentHarness) bool                { return true }

func productionCaps() ports.ChatCapabilities {
	return ports.ChatCapabilities{
		ports.ChatCapabilityStreaming: true,
		ports.ChatCapabilityApprovals: true,
		ports.ChatCapabilityInterrupt: true,
		ports.ChatCapabilityResume:    true,
	}
}

func TestServicePassesRecomputedSystemPromptToResume(t *testing.T) {
	st := openStore(t)
	conv := newFakeConversation()
	var resumed ports.ChatResumeConfig
	svc := chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Drivers: fakeRegistry{driver: fakeDriver{conv: conv, resumeCfg: &resumed}},
		Log:     slog.New(slog.DiscardHandler),
		NewID:   func() string { return "conversation-resume" },
	})
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })

	workspace := t.TempDir()
	dataDir := t.TempDir()
	_, err := svc.Start(context.Background(), chatsvc.StartConfig{
		SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex,
		DataDir: dataDir, WorkspacePath: workspace, ProviderConversationID: "thread-1",
		SystemPrompt: "Recomputed AO orchestrator instructions",
	})
	if err != nil {
		t.Fatalf("Start resume: %v", err)
	}
	if resumed.ProviderConversationID != "thread-1" || resumed.DataDir != dataDir || resumed.WorkspacePath != workspace ||
		resumed.SystemPrompt != "Recomputed AO orchestrator instructions" {
		t.Fatalf("resume config = %#v", resumed)
	}
}

func TestResumeImportsNativeHistoryBeforeTheChatControllerStarts(t *testing.T) {
	st := openStore(t)
	now := time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)
	existing, err := st.CreateConversation(context.Background(), "existing-conversation",
		domain.ConversationScopeSession, testProject, testSession, now)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	if err := st.ClaimChatControllerGeneration(context.Background(), testSession, "old-generation", now); err != nil {
		t.Fatalf("ClaimChatControllerGeneration: %v", err)
	}
	created, err := st.AppendUserMessage(context.Background(), existing.ID, testSession, "old-generation",
		domain.ConversationMessage{
			ID: "existing-user", Text: "What changed?", Origin: domain.MessageOriginHuman,
			ClientMessageID: "original-chat-client-id",
		}, "existing-turn", now)
	if err != nil || !created {
		t.Fatalf("AppendUserMessage: created=%v err=%v", created, err)
	}
	if err := st.BindTurnToProvider(context.Background(), "existing-turn", "native-turn-1", now); err != nil {
		t.Fatalf("BindTurnToProvider: %v", err)
	}
	if err := st.SettleAssistantMessage(context.Background(), existing.ID,
		"native-answer-1", "native-turn-1", "Nothing is dirty.", "existing-answer", now); err != nil {
		t.Fatalf("SettleAssistantMessage: %v", err)
	}
	if err := st.UpsertActivity(context.Background(), existing.ID, "native-turn-1",
		domain.ConversationActivity{
			ID: "existing-command", Kind: domain.ActivityKindCommand, Status: domain.ActivityStatusCompleted,
			Summary: "Ran git status", Detail: json.RawMessage(`{"command":"git status"}`), ProviderItemID: "native-command-1",
		}, now); err != nil {
		t.Fatalf("UpsertActivity: %v", err)
	}
	if err := st.SettleTurn(context.Background(), existing.ID, "native-turn-1", domain.TurnStateCompleted, "", now); err != nil {
		t.Fatalf("SettleTurn: %v", err)
	}

	base := newFakeConversation()
	conv := &nativeHistoryConversation{
		fakeConversation: base,
		events: []ports.ChatEvent{
			{Kind: ports.ChatEventTurnStarted, ProviderEventID: "history-start", ProviderTurnID: "native-turn-1"},
			{
				Kind: ports.ChatEventUserMessageCompleted, ProviderEventID: "history-user",
				ProviderTurnID: "native-turn-1", ProviderItemID: "history-item-1",
				ClientMessageID: "native-client-1", Text: "What changed?",
			},
			{
				Kind: ports.ChatEventActivityCompleted, ProviderEventID: "history-command",
				ProviderTurnID: "native-turn-1", ProviderItemID: "history-item-2",
				ActivityKind: domain.ActivityKindCommand, ActivityStatus: domain.ActivityStatusCompleted,
				Summary: "Ran git status", Detail: json.RawMessage(`{"command":"git status"}`),
			},
			{
				Kind: ports.ChatEventActivityCompleted, ProviderEventID: "history-new-command",
				ProviderTurnID: "native-turn-1", ProviderItemID: "history-item-new-command",
				ActivityKind: domain.ActivityKindCommand, ActivityStatus: domain.ActivityStatusCompleted,
				Summary: "Ran git diff", Detail: json.RawMessage(`{"command":"git diff"}`),
			},
			{
				Kind: ports.ChatEventMessageCompleted, ProviderEventID: "history-answer",
				ProviderTurnID: "native-turn-1", ProviderItemID: "history-item-3", Text: "Nothing is dirty.",
			},
			{
				Kind: ports.ChatEventTurnCompleted, ProviderEventID: "history-complete",
				ProviderTurnID: "native-turn-1", TurnState: domain.TurnStateCompleted,
			},
		},
	}

	var idMu sync.Mutex
	nextID := 0
	svc := chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Reader: chatsvc.SnapshotReaderFunc(func(ctx context.Context, conversationID string) (chatsvc.ConversationRows, error) {
			rows, err := st.LoadConversationSnapshot(ctx, conversationID)
			if err != nil {
				return chatsvc.ConversationRows{}, err
			}
			return chatsvc.ConversationRows{
				Conversation: rows.Conversation,
				Turns:        rows.Turns,
				Messages:     rows.Messages,
				Activities:   rows.Activities,
			}, nil
		}),
		Drivers: fakeRegistry{driver: fakeDriver{conv: conv}},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			idMu.Lock()
			defer idMu.Unlock()
			nextID++
			return fmt.Sprintf("history-id-%d", nextID)
		},
	})
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })

	ctrl, err := svc.Start(context.Background(), chatsvc.StartConfig{
		SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex,
		WorkspacePath: t.TempDir(), ProviderConversationID: "thread-1",
	})
	if err != nil {
		t.Fatalf("Start resume: %v", err)
	}
	snapshot, err := st.LoadConversationSnapshot(context.Background(), ctrl.ConversationID())
	if err != nil {
		t.Fatalf("LoadConversationSnapshot: %v", err)
	}
	// The turn already existed from an earlier Chat interval. Codex can omit its
	// persisted item ids, so the replay uses synthetic item ids even though the
	// live assistant message used native-answer-1. Stable turn identity and the
	// settled content keep the replay from duplicating either message, while the
	// command AO already knew is deduplicated too, while the new command that AO
	// had not seen yet is still imported.
	if len(snapshot.Messages) != 2 || snapshot.Messages[0].Text != "What changed?" || snapshot.Messages[1].Text != "Nothing is dirty." {
		t.Fatalf("imported messages = %#v", snapshot.Messages)
	}
	if len(snapshot.Activities) != 2 || snapshot.Activities[0].Summary != "Ran git status" || snapshot.Activities[1].Summary != "Ran git diff" {
		t.Fatalf("imported activities = %#v", snapshot.Activities)
	}
	if len(snapshot.Turns) != 1 || snapshot.Turns[0].State != domain.TurnStateCompleted {
		t.Fatalf("imported turns = %#v", snapshot.Turns)
	}
	if snapshot.Turns[0].ProviderTurnID != "native-turn-1" {
		t.Fatalf("provider turn = %q, want durable native-turn-1", snapshot.Turns[0].ProviderTurnID)
	}
	if snapshot.Turns[0].CompletedAt == nil || !snapshot.Turns[0].CompletedAt.Equal(now) {
		t.Fatalf("replayed completion = %v, want original %s", snapshot.Turns[0].CompletedAt, now)
	}
}

func TestSlowNativeHistoryDoesNotBlockOtherControllerLookups(t *testing.T) {
	st := openStore(t)
	conv := &blockingHistoryConversation{
		fakeConversation: newFakeConversation(),
		started:          make(chan struct{}),
		release:          make(chan struct{}),
	}
	svc := chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Reader: chatsvc.SnapshotReaderFunc(func(ctx context.Context, conversationID string) (chatsvc.ConversationRows, error) {
			rows, err := st.LoadConversationSnapshot(ctx, conversationID)
			if err != nil {
				return chatsvc.ConversationRows{}, err
			}
			return chatsvc.ConversationRows{
				Conversation: rows.Conversation,
				Turns:        rows.Turns, Messages: rows.Messages, Activities: rows.Activities,
			}, nil
		}),
		Drivers: fakeRegistry{driver: fakeDriver{conv: conv}},
		Log:     slog.New(slog.DiscardHandler),
		NewID:   func() string { return fmt.Sprintf("lock-id-%d", time.Now().UnixNano()) },
	})
	workspace := t.TempDir()
	startDone := make(chan error, 1)
	go func() {
		_, err := svc.Start(context.Background(), chatsvc.StartConfig{
			SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex,
			WorkspacePath: workspace, ProviderConversationID: "thread-1",
		})
		startDone <- err
	}()
	select {
	case <-conv.started:
	case <-time.After(time.Second):
		t.Fatal("native history import did not start")
	}

	lookupDone := make(chan error, 1)
	go func() {
		_, err := svc.Controller(domain.SessionID("another-session"))
		lookupDone <- err
	}()
	select {
	case err := <-lookupDone:
		if !errors.Is(err, chatsvc.ErrNoController) {
			t.Fatalf("Controller error = %v, want ErrNoController", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("a slow native history import blocked an unrelated controller lookup")
	}

	close(conv.release)
	if err := <-startDone; err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })
}

func TestFreshProjectControllerRecordsNativeContextBoundary(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 6, 9, 0, 0, 0, time.UTC)
	conversation, err := st.CreateConversation(ctx, "project-conversation",
		domain.ConversationScopeProject, testProject, testSession, now)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	if err := st.UpsertActivity(ctx, conversation.ID, "", domain.ConversationActivity{
		ID: "old-activity", Kind: domain.ActivityKindSystem, Status: domain.ActivityStatusCompleted,
		Summary: "Earlier project history", ProviderItemID: "old-project-history",
	}, now); err != nil {
		t.Fatalf("seed project history: %v", err)
	}

	const replacement = domain.SessionID("p1-2")
	if _, err := st.CreateSession(ctx, domain.SessionRecord{
		ID: replacement, ProjectID: testProject, Kind: domain.KindOrchestrator,
		Harness: domain.HarnessCodex, Mode: domain.SessionModeChat,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed replacement session: %v", err)
	}

	var idMu sync.Mutex
	nextID := 0
	svc := chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Drivers: fakeRegistry{driver: fakeDriver{conv: newFakeConversation()}},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			idMu.Lock()
			defer idMu.Unlock()
			nextID++
			return fmt.Sprintf("boundary-id-%d", nextID)
		},
		Now: func() time.Time { return now.Add(time.Minute) },
	})
	if _, err := svc.Start(ctx, chatsvc.StartConfig{
		SessionID: replacement, ProjectID: testProject, Kind: domain.KindOrchestrator,
		Harness: domain.HarnessCodex, WorkspacePath: t.TempDir(),
	}); err != nil {
		t.Fatalf("Start replacement: %v", err)
	}
	t.Cleanup(func() { _ = svc.Stop(context.Background(), replacement) })

	rebound, err := st.ConversationForSession(ctx, replacement)
	if err != nil {
		t.Fatalf("ConversationForSession: %v", err)
	}
	if rebound.ID != conversation.ID {
		t.Fatalf("conversation = %q, want project narrative %q", rebound.ID, conversation.ID)
	}
	snapshot, err := st.LoadConversationSnapshot(ctx, rebound.ID)
	if err != nil {
		t.Fatalf("LoadConversationSnapshot: %v", err)
	}
	if len(snapshot.Activities) != 2 {
		t.Fatalf("activities = %#v, want old history plus context boundary", snapshot.Activities)
	}
	boundary := snapshot.Activities[1]
	if boundary.Kind != domain.ActivityKindSystem || boundary.ProviderItemID != "ao-context-reset:p1-2" {
		t.Fatalf("boundary = %#v", boundary)
	}
	var detail map[string]string
	if err := json.Unmarshal(boundary.Detail, &detail); err != nil {
		t.Fatalf("decode boundary detail: %v", err)
	}
	if detail["event"] != "context.reset" {
		t.Fatalf("boundary event = %q", detail["event"])
	}
}

/* ---- harness ----------------------------------------------------------- */

type harness struct {
	svc  *chatsvc.Service
	st   *sqlite.Store
	conv *fakeConversation
	ctrl *chatsvc.Controller

	clockMu sync.Mutex
	clock   time.Time
}

// advance moves the injected clock. Needed where an ordering rule is expressed in
// timestamps — the queue cancellation cutoff — rather than in call order.
func (h *harness) advance(d time.Duration) {
	h.clockMu.Lock()
	defer h.clockMu.Unlock()
	h.clock = h.clock.Add(d)
}

func (h *harness) now() time.Time {
	h.clockMu.Lock()
	defer h.clockMu.Unlock()
	return h.clock
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithConversation(t, nil)
}

// newHarnessWithConversation lets a test supply its own provider double, for the
// cases where the interesting behavior is how the provider answers rather than
// what it streams. A nil conv gets the plain fake.
func newHarnessWithConversation(t *testing.T, conv ports.ChatConversation) *harness {
	t.Helper()
	st := openStore(t)
	base := newFakeConversation()
	if conv == nil {
		conv = base
	} else if recorder, ok := conv.(*interruptRecorder); ok {
		base = recorder.fakeConversation
	} else if recorder, ok := conv.(*historyRecorder); ok {
		base = recorder.fakeConversation
	}
	h := &harness{st: st, conv: base, clock: time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC)}

	// Guarded because the id factory is called from both the projection goroutine and
	// whichever goroutine a test drives commands from, and an unsynchronized counter
	// is a data race the -race build fails on rather than a harmless test detail.
	var (
		counterMu sync.Mutex
		counter   int
	)
	svc := chatsvc.New(chatsvc.Options{
		Store:    st,
		Sessions: st,
		Drivers:  fakeRegistry{driver: fakeDriver{conv: conv}},
		Log:      slog.New(slog.DiscardHandler),
		NewID: func() string {
			counterMu.Lock()
			defer counterMu.Unlock()
			counter++
			return fmt.Sprintf("id-%03d", counter)
		},
		Now: h.now,
	})

	ctrl, err := svc.Start(context.Background(), chatsvc.StartConfig{
		SessionID:     testSession,
		ProjectID:     testProject,
		Harness:       domain.HarnessCodex,
		WorkspacePath: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })

	h.svc, h.ctrl = svc, ctrl
	return h
}

// awaitSnapshot polls until pred holds, so a test does not race the projector.
func (h *harness) awaitSnapshot(t *testing.T, pred func(store.ConversationSnapshot) bool) store.ConversationSnapshot {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last store.ConversationSnapshot
	for time.Now().Before(deadline) {
		snapshot, err := h.st.LoadConversationSnapshot(context.Background(), h.ctrl.ConversationID())
		if err != nil {
			t.Fatalf("load snapshot: %v", err)
		}
		last = snapshot
		if pred(snapshot) {
			return snapshot
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("snapshot never satisfied the condition; last had %d messages, %d activities, %d turns",
		len(last.Messages), len(last.Activities), len(last.Turns))
	return last
}

func TestStaleControllerEventsDoNotReachTheTimeline(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if err := h.st.ClaimChatControllerGeneration(ctx, testSession, "replacement-generation", h.now()); err != nil {
		t.Fatalf("replace controller generation: %v", err)
	}

	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventMessageDelta,
		ProviderTurnID: "stale-turn",
		ProviderItemID: "stale-message",
		Delta:          "must not survive",
	})
	if err := h.svc.Stop(ctx, testSession); err != nil {
		t.Fatalf("stop stale controller: %v", err)
	}

	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	for _, message := range snapshot.Messages {
		if message.Text == "must not survive" {
			t.Fatalf("stale controller message was projected: %+v", message)
		}
	}
}

/* ---- tests ------------------------------------------------------------- */

// The whole point: a message goes out, provider events come back, and the durable
// timeline reflects them in sequence order.
func TestProjectsAFullTurnIntoDurableRows(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "what changed?",
		ClientMessageID: "client-1",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if turn.ProviderTurnID != "provider-turn-1" {
		t.Fatalf("provider turn = %q", turn.ProviderTurnID)
	}

	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"},
		ports.ChatEvent{
			Kind: ports.ChatEventActivityCompleted, ProviderTurnID: "provider-turn-1",
			ProviderItemID: "exec-1", ActivityKind: domain.ActivityKindCommand,
			ActivityStatus: domain.ActivityStatusCompleted, Summary: "git status --short",
		},
		// Streaming arrives in pieces and must fold into one message.
		ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: "provider-turn-1", ProviderItemID: "msg-1", Delta: "Two "},
		ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: "provider-turn-1", ProviderItemID: "msg-1", Delta: "files "},
		ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: "provider-turn-1", ProviderItemID: "msg-1", Delta: "changed."},
		ports.ChatEvent{Kind: ports.ChatEventMessageCompleted, ProviderTurnID: "provider-turn-1", ProviderItemID: "msg-1", Text: "Two files changed."},
		ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted},
	)

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State.Terminal() && len(s.Messages) == 2
	})

	if got := snapshot.Turns[0].State; got != domain.TurnStateCompleted {
		t.Errorf("turn state = %q, want completed", got)
	}

	user, assistant := snapshot.Messages[0], snapshot.Messages[1]
	if user.Role != domain.MessageRoleUser || user.Text != "what changed?" {
		t.Errorf("user message = %+v", user)
	}
	if user.Origin != domain.MessageOriginHuman {
		t.Errorf("user origin = %q", user.Origin)
	}
	// Three deltas folded into one message, not three timeline entries.
	if assistant.Role != domain.MessageRoleAssistant || assistant.Text != "Two files changed." {
		t.Errorf("assistant message = %+v", assistant)
	}
	if assistant.Streaming {
		t.Error("assistant message still marked streaming after completion")
	}
	if assistant.Revision == 0 {
		t.Error("assistant revision never advanced despite streaming rewrites")
	}

	// Sequence is conversation-scoped and strictly increasing across both tables.
	var sequences []int64
	for _, m := range snapshot.Messages {
		sequences = append(sequences, m.Sequence)
	}
	for _, a := range snapshot.Activities {
		sequences = append(sequences, a.Sequence)
	}
	seen := map[int64]bool{}
	for _, seq := range sequences {
		if seen[seq] {
			t.Fatalf("sequence %d was handed out twice", seq)
		}
		seen[seq] = true
	}

	if len(snapshot.Activities) != 1 || snapshot.Activities[0].Summary != "git status --short" {
		t.Fatalf("activities = %+v", snapshot.Activities)
	}
}

func TestControllerCloseHonorsContextWhenProviderStreamStaysOpen(t *testing.T) {
	providerErr := errors.New("provider close failed")
	conv := &stuckConversation{fakeConversation: newFakeConversation(), closeErr: providerErr}
	h := newHarnessWithConversation(t, conv)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	err := h.ctrl.Close(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, providerErr) {
		t.Fatalf("Close error = %v, want provider error joined with deadline", err)
	}
	// Let the projection goroutine exit so the harness cleanup remains bounded.
	close(conv.events)
	h.ctrl.Wait()
}

// A retried send under the same client message id must not create a second turn.
func TestDuplicateSendDoesNotCreateASecondTurn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	msg := ports.ChatUserMessage{Text: "hello", ClientMessageID: "client-dup", Origin: domain.MessageOriginHuman}

	if _, err := h.svc.Send(ctx, testSession, msg); err != nil {
		t.Fatalf("first Send: %v", err)
	}
	second, err := h.svc.Send(ctx, testSession, msg)
	if err != nil {
		t.Fatalf("retried Send returned an error instead of being ignored: %v", err)
	}
	if second.ProviderTurnID != "" {
		t.Errorf("retry reported a new provider turn %q", second.ProviderTurnID)
	}

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Turns) >= 1 })
	if len(snapshot.Turns) != 1 {
		t.Fatalf("turns = %d, want 1", len(snapshot.Turns))
	}
	if len(snapshot.Messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(snapshot.Messages))
	}
}

func TestDeferredDriverStartsOnlyAfterProviderTurnIDIsDurable(t *testing.T) {
	deferred := &deferredConversation{fakeConversation: newFakeConversation()}
	h := newHarnessWithConversation(t, deferred)
	deferred.start = func(providerTurnID string) error {
		snapshot, err := h.st.LoadConversationSnapshot(context.Background(), h.ctrl.ConversationID())
		if err != nil {
			return err
		}
		for _, turn := range snapshot.Turns {
			if turn.ProviderTurnID == providerTurnID {
				return nil
			}
		}
		return fmt.Errorf("provider turn %q was not bound before deferred start", providerTurnID)
	}

	turn, err := h.svc.Send(context.Background(), testSession, ports.ChatUserMessage{
		Text: "start through ACP", ClientMessageID: "deferred-1", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if turn.ProviderTurnID == "" {
		t.Fatal("deferred turn has no provider id")
	}
}

// An approval must be stored pending, carry the provider's own decision list, and
// only resolve through a typed action.
func TestApprovalIsStoredPendingWithProviderDecisions(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "go", ClientMessageID: "c1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	// The real captured shape: no decline on offer, plus a structured decision.
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventApprovalRequested,
		ProviderTurnID: "provider-turn-1",
		ProviderItemID: "0",
		RequestID:      "0",
		ActivityKind:   domain.ActivityKindCommand,
		ActivityStatus: domain.ActivityStatusPending,
		Summary:        "Run ao spawn",
		Decisions: []ports.ChatDecisionOption{
			{ID: "accept", Label: "Approve"},
			{ID: "acceptWithExecpolicyAmendment", Label: "Approve and remember this command"},
			{ID: "cancel", Label: "Cancel"},
		},
	})

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Activities) == 1
	})
	approval := snapshot.Activities[0]
	if approval.Kind != domain.ActivityKindApproval {
		t.Fatalf("kind = %q, want approval", approval.Kind)
	}
	if approval.Status != domain.ActivityStatusPending {
		t.Fatalf("status = %q, want pending", approval.Status)
	}
	if approval.RequestID != "0" {
		t.Fatalf("request id = %q; zero is a legitimate id and must survive", approval.RequestID)
	}

	var detail struct {
		Decisions []struct{ ID, Label string } `json:"decisions"`
	}
	if err := json.Unmarshal(approval.Detail, &detail); err != nil {
		t.Fatalf("detail not decodable: %v (%s)", err, approval.Detail)
	}
	if len(detail.Decisions) != 3 {
		t.Fatalf("stored %d decisions, want the provider's 3: %+v", len(detail.Decisions), detail.Decisions)
	}
	for _, d := range detail.Decisions {
		if d.ID == "decline" {
			t.Error("stored a decline option the provider never offered")
		}
	}

	// Resolving reaches the provider and then updates the row.
	if err := h.svc.Resolve(ctx, testSession, "0", ports.ChatDecision{ID: "accept"}); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if _, ok := h.conv.decisionFor("0"); !ok {
		t.Error("decision never reached the provider")
	}
	resolved := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Activities) == 1 && s.Activities[0].Status == domain.ActivityStatusResolved
	})
	if resolved.Activities[0].Status != domain.ActivityStatusResolved {
		t.Fatalf("status = %q, want resolved", resolved.Activities[0].Status)
	}
}

// A controller that dies mid-turn must not leave the turn looking like it is still
// working, and must not leave an approval the user can never answer.
func TestControllerDeathSettlesInFlightWork(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "go", ClientMessageID: "c1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"},
		startedCommand("provider-turn-1", "exec-1", "sleep 60"),
	)
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Activities) == 1 })
	h.conv.emit(
		ports.ChatEvent{
			Kind: ports.ChatEventApprovalRequested, ProviderTurnID: "provider-turn-1",
			ProviderItemID: "0", RequestID: "0", ActivityKind: domain.ActivityKindCommand,
			ActivityStatus: domain.ActivityStatusPending, Summary: "Run something",
		},
	)
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Activities) == 2 })

	// The provider process dies: the stream closes with the turn still open.
	_ = h.conv.Close()
	h.ctrl.Wait()
	if err := h.svc.Stop(ctx, testSession); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State.Terminal()
	})
	if got := snapshot.Turns[0].State; got != domain.TurnStateFailed {
		t.Errorf("turn state = %q; an interrupted controller is not a completed turn", got)
	}
	if snapshot.Turns[0].ErrorMessage == "" {
		t.Error("orphaned turn carries no explanation")
	}
	if got := findActivity(t, snapshot, "0").Status; got == domain.ActivityStatusPending {
		t.Error("approval left pending after its controller died — the user can never answer it")
	}
	if got := findActivity(t, snapshot, "exec-1").Status; got != domain.ActivityStatusFailed {
		t.Errorf("running activity after controller death = %q, want failed", got)
	}
}

// Dispatch reads the persisted mode. A TUI session must be refused even if a
// controller somehow exists, because the mode is the authority.
func TestSendRefusedForTUISession(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	tuiSession := domain.SessionID("p1-2")
	if _, err := h.st.CreateSession(ctx, domain.SessionRecord{
		ID:        tuiSession,
		ProjectID: testProject,
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Mode:      domain.SessionModeTUI,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed tui session: %v", err)
	}

	_, err := h.svc.Send(ctx, tuiSession, ports.ChatUserMessage{Text: "hi", ClientMessageID: "c9"})
	if err == nil {
		t.Fatal("a TUI session accepted a chat send")
	}
	if !errorsIs(err, chatsvc.ErrNotChatMode) {
		t.Fatalf("err = %v, want ErrNotChatMode", err)
	}
}

// Every projected event is also archived, so a wrong projection can be repaired
// from the raw record instead of being the only surviving account.
func TestProviderEventsAreArchived(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "go", ClientMessageID: "c1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"},
		ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: "provider-turn-1", ProviderItemID: "msg-1", Delta: "hi"},
		ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted},
	)
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State.Terminal()
	})

	events, err := h.st.ProviderEventsSince(ctx, h.ctrl.ConversationID(), 0, 100)
	if err != nil {
		t.Fatalf("read archive: %v", err)
	}
	if len(events) < 3 {
		t.Fatalf("archived %d events, want at least the 3 emitted", len(events))
	}
}

/* ---- the send queue ---------------------------------------------------- */

// turnStateByText is how the queue tests read the timeline: a turn matters here
// only as the fate of one message the user typed.
func turnStateByText(t *testing.T, s store.ConversationSnapshot) map[string]domain.TurnState {
	t.Helper()
	turns := map[string]domain.ConversationTurn{}
	for _, turn := range s.Turns {
		turns[turn.ID] = turn
	}
	states := map[string]domain.TurnState{}
	for _, msg := range s.Messages {
		if msg.Role != domain.MessageRoleUser {
			continue
		}
		if turn, ok := turns[msg.TurnID]; ok {
			states[msg.Text] = turn.State
		}
	}
	return states
}

// The composer tells the user a mid-turn message is queued until the agent
// finishes. That has to be true of the daemon, not just of the placeholder: a
// second turn/start against a busy provider is not a thing the agent can run.
func TestSendWhileBusyQueuesUntilTheTurnEnds(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "first", ClientMessageID: "c1", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("first Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State == domain.TurnStateRunning
	})

	queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "second", ClientMessageID: "c2", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("mid-turn Send: %v", err)
	}
	if queued.State != domain.TurnStateQueued {
		t.Errorf("mid-turn send reported state %q, want queued", queued.State)
	}
	if queued.ProviderTurnID != "" {
		t.Errorf("mid-turn send claimed provider turn %q; it was never dispatched", queued.ProviderTurnID)
	}
	if got := h.conv.sentTexts(); len(got) != 1 {
		t.Fatalf("provider received %v; the second message must wait", got)
	}

	// The running turn ends, so the queued message goes out on its own.
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateCompleted,
	})

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return turnStateByText(t, s)["second"] == domain.TurnStateRunning
	})
	states := turnStateByText(t, snapshot)
	if states["first"] != domain.TurnStateCompleted {
		t.Errorf("first turn = %q, want completed", states["first"])
	}
	if got := h.conv.sentTexts(); len(got) != 2 || got[1] != "second" {
		t.Fatalf("provider received %v, want the queued message dispatched second", got)
	}
}

// Stop is a brake. Releasing the queue when the user presses it would be the
// opposite of what the button says, so anything waiting is cancelled with the turn.
func TestInterruptCancelsWhatIsQueuedBehindTheTurn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "running", ClientMessageID: "c1",
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State == domain.TurnStateRunning
	})
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "queued", ClientMessageID: "c2",
	}); err != nil {
		t.Fatalf("mid-turn Send: %v", err)
	}

	if err := h.svc.Interrupt(ctx, testSession); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateInterrupted,
	})

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		states := turnStateByText(t, s)
		return states["queued"].Terminal() && states["running"].Terminal()
	})
	states := turnStateByText(t, snapshot)
	if states["queued"] != domain.TurnStateInterrupted {
		t.Errorf("queued turn = %q; a message never dispatched did not fail, it was cancelled",
			states["queued"])
	}
	if got := h.conv.sentTexts(); len(got) != 1 {
		t.Fatalf("provider received %v; stop must not release the queue", got)
	}
}

func TestChatHandoffDrainFinishesAcceptedQueueAndClosesNewIntake(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "running", ClientMessageID: "handoff-1",
	}); err != nil {
		t.Fatalf("send running turn: %v", err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State == domain.TurnStateRunning
	})
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "already queued", ClientMessageID: "handoff-2",
	}); err != nil {
		t.Fatalf("queue second turn: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- h.svc.PrepareChatHandoff(ctx, testSession, domain.SessionInterfaceTransitionDrain)
	}()
	// Completion of the first accepted turn must dispatch the accepted queue,
	// rather than declaring the source quiescent early.
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateCompleted,
	})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return turnStateByText(t, s)["already queued"] == domain.TurnStateRunning
	})
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-2",
		TurnState: domain.TurnStateCompleted,
	})
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("prepare handoff: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("handoff did not become quiescent after its accepted queue completed")
	}

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "too late", ClientMessageID: "handoff-3",
	}); !errors.Is(err, chatsvc.ErrControllerHandoff) {
		t.Fatalf("send after handoff gate = %v, want ErrControllerHandoff", err)
	}
	h.svc.AbortChatHandoff(testSession)
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "source reopened", ClientMessageID: "handoff-4",
	}); err != nil {
		t.Fatalf("send after aborting handoff: %v", err)
	}
}

func TestChatHandoffTreatsMissingControllerAsAlreadyQuiescent(t *testing.T) {
	svc := chatsvc.New(chatsvc.Options{})
	if err := svc.PrepareChatHandoff(
		context.Background(), "missing-controller", domain.SessionInterfaceTransitionDrain,
	); err != nil {
		t.Fatalf("prepare missing controller: %v", err)
	}
}

func TestServiceStopRetainsControllerUntilItsEventStreamActuallyEnds(t *testing.T) {
	base := newFakeConversation()
	h := newHarnessWithConversation(t, &stuckConversation{
		fakeConversation: base,
		closeErr:         errors.New("provider close failed"),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := h.svc.Stop(ctx, testSession); err == nil {
		t.Fatal("Stop error = nil, want provider close failure or deadline")
	}
	if _, err := h.svc.Controller(testSession); err != nil {
		t.Fatalf("controller was forgotten while its stream was still live: %v", err)
	}

	base.closeOnce.Do(func() { close(base.events) })
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := h.svc.Controller(testSession); errors.Is(err, chatsvc.ErrNoController) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("controller registry did not release the stopped stream")
}

// The cancellation belongs to the moment stop was pressed. A message typed after
// that is the user asking for new work, and must not be swept up by it.
func TestMessageTypedAfterStopIsStillDelivered(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "running", ClientMessageID: "c1",
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State == domain.TurnStateRunning
	})
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "before stop", ClientMessageID: "c2",
	}); err != nil {
		t.Fatalf("Send before stop: %v", err)
	}

	if err := h.svc.Interrupt(ctx, testSession); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}

	// The user changes their mind and types again while the interrupt lands.
	h.advance(time.Second)
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "after stop", ClientMessageID: "c3",
	}); err != nil {
		t.Fatalf("Send after stop: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateInterrupted,
	})

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return turnStateByText(t, s)["after stop"] == domain.TurnStateRunning
	})
	states := turnStateByText(t, snapshot)
	if states["before stop"] != domain.TurnStateInterrupted {
		t.Errorf("pre-stop message = %q, want interrupted", states["before stop"])
	}
	if got := h.conv.sentTexts(); len(got) != 2 || got[1] != "after stop" {
		t.Fatalf("provider received %v, want the post-stop message delivered", got)
	}
}

func errorsIs(err, target error) bool {
	for err != nil {
		if errors.Is(err, target) {
			return true
		}
		unwrapped, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapped.Unwrap()
	}
	return false
}

// The initial prompt is the user's task brief, so it must render as their message
// rather than as a system notice. Origin records who authored a message, not who
// delivered it to the provider.
func TestInitialPromptIsAttributedToTheUser(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.StartChatTurn(ctx, testSession, "Explain the whole design system"); err != nil {
		t.Fatalf("StartChatTurn: %v", err)
	}

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Messages) >= 1
	})
	first := snapshot.Messages[0]
	if first.Origin != domain.MessageOriginHuman {
		t.Fatalf("initial prompt origin = %q, want %q — the daemon delivers it but the user wrote it",
			first.Origin, domain.MessageOriginHuman)
	}
	if first.Role != domain.MessageRoleUser {
		t.Errorf("initial prompt role = %q, want user", first.Role)
	}
}

// A relayed message is AO carrying someone else's words: `ao send`, or an
// orchestrator writing to a worker. It must be attributed to automation, not
// passed off as something the user typed here — the timeline distinguishes the
// two structurally, and a reader should never have to infer it from a prefix.
func TestRelayedMessageIsAttributedToAutomation(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if _, err := h.svc.RelayChatTurn(ctx, testSession, "orchestrator: rebase onto main"); err != nil {
		t.Fatalf("RelayChatTurn: %v", err)
	}

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Messages) >= 1
	})
	msg := snapshot.Messages[0]
	if msg.Origin != domain.MessageOriginAutomation {
		t.Fatalf("relay origin = %q, want %q", msg.Origin, domain.MessageOriginAutomation)
	}
	if msg.Role != domain.MessageRoleUser {
		t.Errorf("relay role = %q; a relay is still an inbound request", msg.Role)
	}
	if got := h.conv.sentTexts(); len(got) != 1 || got[0] != "orchestrator: rebase onto main" {
		t.Fatalf("provider received %v, want the relayed text dispatched", got)
	}
}

// interruptRecorder answers turn/interrupt the way the provider does: it refuses
// any turn it has not been told to consider active.
type interruptRecorder struct {
	*fakeConversation
	activeMu sync.Mutex
	active   map[string]bool
	attempts []string
}

func newInterruptRecorder() *interruptRecorder {
	return &interruptRecorder{fakeConversation: newFakeConversation(), active: map[string]bool{}}
}

func (r *interruptRecorder) markActive(turn string) {
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	r.active[turn] = true
}

func (r *interruptRecorder) Interrupt(_ context.Context, turn string) error {
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	r.attempts = append(r.attempts, turn)
	if !r.active[turn] {
		return ports.ErrChatNoActiveTurn
	}
	return nil
}

func (r *interruptRecorder) attemptCount() int {
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	return len(r.attempts)
}

// Stop appears the moment a message is sent, so a user can press it before the
// provider has acknowledged the turn — and a provider refuses to cancel a turn it
// does not yet consider active. Interrupt waits out that gap rather than handing
// back a failure in the exact moment someone realizes they sent the wrong thing.
func TestInterruptWaitsForTheProviderToAcknowledgeTheTurn(t *testing.T) {
	conv := newInterruptRecorder()
	h := newHarnessWithConversation(t, conv)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "go", ClientMessageID: "c1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	// The acknowledgement lands while Interrupt is already waiting.
	go func() {
		time.Sleep(150 * time.Millisecond)
		conv.markActive("provider-turn-1")
		conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	}()

	if err := h.svc.Interrupt(ctx, testSession); err != nil {
		t.Fatalf("Interrupt raced the provider's acknowledgement: %v", err)
	}
	if got := conv.attemptCount(); got != 1 {
		t.Errorf("interrupt attempts = %d, want 1", got)
	}
}

// A provider that refuses because the turn is genuinely gone must reach the client
// as the same typed "nothing to interrupt" answer AO produces itself — not as a
// protocol error that renders as an internal failure.
func TestProviderRefusalBecomesTheTypedNoActiveTurnError(t *testing.T) {
	conv := newInterruptRecorder() // never marks anything active
	h := newHarnessWithConversation(t, conv)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "go", ClientMessageID: "c1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	err := h.svc.Interrupt(ctx, testSession)
	if !errorsIs(err, chatsvc.ErrNoActiveTurn) {
		t.Fatalf("err = %v, want ErrNoActiveTurn", err)
	}
}

// A daemon that is killed never runs its own cleanup, so whatever the dead
// controller left in flight is still marked live on disk. The next controller to
// come up has to close it out: nothing else ever will, and until then the timeline
// claims a turn is running and a queued message is waiting to be sent behind a
// controller that no longer exists.
func TestStartSettlesWorkLeftByAKilledController(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// A turn in flight and a message queued behind it, exactly as a crash leaves them.
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "running", ClientMessageID: "c1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State == domain.TurnStateRunning
	})
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "queued", ClientMessageID: "c2"}); err != nil {
		t.Fatalf("mid-turn Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventApprovalRequested, ProviderTurnID: "provider-turn-1",
		ProviderItemID: "9", RequestID: "9", ActivityKind: domain.ActivityKindCommand,
		ActivityStatus: domain.ActivityStatusPending, Summary: "Run something",
	})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Activities) == 1 })

	// A killed daemon leaves the rows mid-flight and takes its service with it, so
	// the next controller comes up in a NEW service over the SAME store. Building
	// it that way rather than reusing this one is the point: nothing in the old
	// process gets a chance to clean up.
	next := chatsvc.New(chatsvc.Options{
		Store:    h.st,
		Sessions: h.st,
		Drivers:  fakeRegistry{driver: fakeDriver{conv: newFakeConversation()}},
		Log:      slog.New(slog.DiscardHandler),
		NewID:    func() string { return "next-" + fmt.Sprint(time.Now().UnixNano()) },
		Now:      h.now,
	})
	t.Cleanup(func() { _ = next.Stop(context.Background(), testSession) })

	if _, err := next.Start(ctx, chatsvc.StartConfig{
		SessionID:              testSession,
		ProjectID:              testProject,
		Harness:                domain.HarnessCodex,
		WorkspacePath:          t.TempDir(),
		ProviderConversationID: "thread-1",
	}); err != nil {
		t.Fatalf("Start after crash: %v", err)
	}

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		for _, turn := range s.Turns {
			if !turn.State.Terminal() {
				return false
			}
		}
		return len(s.Turns) == 2
	})
	states := turnStateByText(t, snapshot)
	if states["running"] != domain.TurnStateFailed {
		t.Errorf("turn abandoned mid-flight = %q, want failed", states["running"])
	}
	if states["queued"] != domain.TurnStateFailed {
		t.Errorf("message left queued by a dead controller = %q; nothing would ever send it",
			states["queued"])
	}
	if got := snapshot.Activities[0].Status; got == domain.ActivityStatusPending {
		t.Error("approval left pending by a dead controller; the user can never answer it")
	}
}

// Usage is current state, not history. The provider reports it after every tool
// call, so the projection must overwrite: a row per report is what buried the
// conversation, and the conversation is only ever one amount full.
func TestUsageProjectionKeepsOnlyTheLatest(t *testing.T) {
	h := newHarness(t)

	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
			ContextUsed: 18055, ContextWindow: 258400,
			InputTokens: 18050, OutputTokens: 5, CachedTokens: 11008, TotalTokens: 18055,
		}},
		ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
			ContextUsed: 42100, ContextWindow: 258400,
			InputTokens: 41000, OutputTokens: 1100, CachedTokens: 20000, TotalTokens: 60155,
		}},
	)

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.Usage != nil && s.Conversation.Usage.ContextUsed == 42100
	})

	usage := snapshot.Conversation.Usage
	if usage.ContextWindow != 258400 {
		t.Errorf("context window = %d, want 258400", usage.ContextWindow)
	}
	if usage.TotalTokens != 60155 {
		t.Errorf("cumulative total = %d, want the later 60155", usage.TotalTokens)
	}
	// The readout is only meaningful as a fraction; without the window it is a
	// number with no scale, which is what the header used to show.
	if got := usage.ContextFraction(); got < 0.16 || got > 0.17 {
		t.Errorf("context fraction = %v, want roughly 0.163", got)
	}

	// Usage must not become a timeline entry, under any kind.
	for _, activity := range snapshot.Activities {
		if activity.Kind == domain.ActivityKindUsage {
			t.Fatalf("usage was projected as an activity: %+v", activity)
		}
	}
}

// ACP reports context fullness and cumulative token totals in separate messages.
// A later totals update must not erase the context window received just before it.
func TestUsageProjectionMergesIndependentProviderUpdates(t *testing.T) {
	h := newHarness(t)

	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
			ContextUsed: 74300, ContextWindow: 1_000_000, ContextKnown: true,
		}},
		ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
			InputTokens: 2, OutputTokens: 59, CachedTokens: 74216,
			TotalTokens: 74277, TotalsKnown: true,
		}},
	)

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.Usage != nil && s.Conversation.Usage.TotalTokens == 74277
	})
	usage := snapshot.Conversation.Usage
	if usage.ContextUsed != 74300 || usage.ContextWindow != 1_000_000 {
		t.Fatalf("context usage was erased by totals update: %+v", usage)
	}
	if usage.CachedTokens != 74216 {
		t.Fatalf("cumulative totals were not merged: %+v", usage)
	}
}

// A model the provider states no window for still reports its tokens. The meter
// has to say "unknown" rather than draw an empty bar for a conversation that may
// be nearly full.
func TestUsageProjectionWithoutContextWindow(t *testing.T) {
	h := newHarness(t)

	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
		ContextUsed: 900, TotalTokens: 900, InputTokens: 800, OutputTokens: 100,
	}})

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.Usage != nil
	})
	if got := snapshot.Conversation.Usage.ContextFraction(); got != -1 {
		t.Errorf("context fraction = %v, want -1 for an unknown window", got)
	}
}

// Rate limits are current state too, and an unreported window must survive a round
// trip through the database as unreported rather than as a reassuring zero.
func TestRateLimitProjectionKeepsOnlyTheLatest(t *testing.T) {
	h := newHarness(t)

	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventRateLimits, RateLimits: &ports.ChatRateLimits{
			PrimaryUsedPercent: 12, SecondaryUsedPercent: -1,
			PrimaryResetsInSeconds: 600, PlanLabel: "pro",
		}},
		ports.ChatEvent{Kind: ports.ChatEventRateLimits, RateLimits: &ports.ChatRateLimits{
			PrimaryUsedPercent: 71, SecondaryUsedPercent: -1,
			PrimaryResetsInSeconds: 490444, PlanLabel: "pro",
		}},
	)

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.RateLimits != nil && s.Conversation.RateLimits.PrimaryUsedPercent == 71
	})

	limits := snapshot.Conversation.RateLimits
	if limits.SecondaryUsedPercent >= 0 {
		t.Errorf("secondary = %v; an unreported window must not read as untouched quota",
			limits.SecondaryUsedPercent)
	}
	if limits.PrimaryResetsInSeconds != 490444 {
		t.Errorf("primary resets in %d, want 490444", limits.PrimaryResetsInSeconds)
	}
	if limits.PlanLabel != "pro" {
		t.Errorf("plan = %q, want pro", limits.PlanLabel)
	}
	if got := limits.WorstUsedPercent(); got != 71 {
		t.Errorf("worst window = %v, want 71", got)
	}
}

// Nothing reported yet is distinct from a conversation using nothing: the snapshot
// leaves both nil so a client can withhold the meter rather than draw an empty one.
func TestSnapshotOmitsUsageUntilTheProviderReports(t *testing.T) {
	h := newHarness(t)

	snapshot, err := h.st.LoadConversationSnapshot(context.Background(), h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if snapshot.Conversation.Usage != nil {
		t.Errorf("usage = %+v, want nil before the provider reports", snapshot.Conversation.Usage)
	}
	if snapshot.Conversation.RateLimits != nil {
		t.Errorf("rate limits = %+v, want nil before the provider reports",
			snapshot.Conversation.RateLimits)
	}
}

/* ---- compaction --------------------------------------------------------- */

// compactingConversation is a provider that can reclaim context. The plain fake
// deliberately cannot, so the unsupported path stays exercised by every other test.
type compactingConversation struct {
	*fakeConversation

	compactMu sync.Mutex
	calls     int
}

func newCompactingConversation() *compactingConversation {
	return &compactingConversation{fakeConversation: newFakeConversation()}
}

func (c *compactingConversation) Compact(context.Context) (ports.ChatCompactionResult, error) {
	c.compactMu.Lock()
	defer c.compactMu.Unlock()
	c.calls++
	// What is about to be reclaimed, not what was: the real provider accepts the
	// request and does the work as its own turn afterwards.
	return ports.ChatCompactionResult{TokensBefore: 15650}, nil
}

func (c *compactingConversation) compactCalls() int {
	c.compactMu.Lock()
	defer c.compactMu.Unlock()
	return c.calls
}

// A compaction has to survive a restart, which means it has to be a row. Without
// one, a conversation that quietly lost half its history has nothing in the
// timeline to explain the gap, and reads as if the agent simply forgot.
func TestCompactionIsProjectedAsATimelineFact(t *testing.T) {
	conv := newCompactingConversation()
	h := newHarnessWithConversation(t, conv)

	conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventCompacted,
		ProviderTurnID: "compact-turn",
		ProviderItemID: "cc-1",
		Summary:        "Compacted history, freeing 11.0k tokens",
		Detail:         []byte(`{"tokensBefore":15650,"tokensAfter":4632,"tokensReclaimed":11018}`),
	})

	// Both writes, because the row and the conversation flag are two statements and
	// this test asserts on both: waiting only on the row races the flag.
	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Activities) == 1 && s.Conversation.CompactedAt != nil
	})
	activity := snapshot.Activities[0]
	if activity.Kind != domain.ActivityKindSystem {
		t.Errorf("kind = %q, want system", activity.Kind)
	}
	if activity.Status != domain.ActivityStatusCompleted {
		t.Errorf("status = %q, want completed", activity.Status)
	}
	if activity.Summary != "Compacted history, freeing 11.0k tokens" {
		t.Errorf("summary = %q", activity.Summary)
	}
	if activity.ProviderItemID != "cc-1" {
		t.Errorf("provider item id = %q, want cc-1 so a replay updates this row", activity.ProviderItemID)
	}
	// Not attached to a turn: the provider ran the compaction in a turn AO never
	// dispatched, so filing the row under it would attribute the entry to work the
	// user never asked for.
	if activity.TurnID != "" {
		t.Errorf("turn id = %q, want none", activity.TurnID)
	}
	var detail struct{ TokensReclaimed int64 }
	if err := json.Unmarshal(activity.Detail, &detail); err != nil {
		t.Fatalf("detail: %v", err)
	}
	if detail.TokensReclaimed != 11018 {
		t.Errorf("reclaimed = %d, want 11018", detail.TokensReclaimed)
	}

	// The conversation itself records that compaction has run, so a client does not
	// have to scan an unbounded timeline to find out.
	if snapshot.Conversation.CompactedAt == nil {
		t.Error("conversation was not marked compacted")
	}
}

// A compaction replayed across a reconnect updates the row it already has. Two
// entries for one compaction would read as two, and the reclaim would look twice
// as large as it was.
func TestCompactionReplayDoesNotDuplicateTheRow(t *testing.T) {
	conv := newCompactingConversation()
	h := newHarnessWithConversation(t, conv)

	for range 2 {
		conv.emit(ports.ChatEvent{
			Kind:           ports.ChatEventCompacted,
			ProviderItemID: "cc-1",
			Summary:        "Compacted the conversation history",
		})
	}
	// A marker after both, so this waits on an event rather than on a timeout.
	conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventActivityCompleted, ProviderItemID: "exec-1",
		ActivityKind: domain.ActivityKindCommand, ActivityStatus: domain.ActivityStatusCompleted,
		Summary: "date -u",
	})

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		for _, activity := range s.Activities {
			if activity.ProviderItemID == "exec-1" {
				return true
			}
		}
		return false
	})
	compactions := 0
	for _, activity := range snapshot.Activities {
		if activity.Kind == domain.ActivityKindSystem {
			compactions++
		}
	}
	if compactions != 1 {
		t.Fatalf("got %d compaction rows for one compaction", compactions)
	}
}

func TestCompactReportsWhatIsAboutToBeReclaimed(t *testing.T) {
	conv := newCompactingConversation()
	h := newHarnessWithConversation(t, conv)

	result, err := h.svc.Compact(context.Background(), testSession)
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if result.TokensBefore != 15650 {
		t.Errorf("tokensBefore = %d, want 15650", result.TokensBefore)
	}
	// Zero means "not yet known", not "reclaimed everything". The settled figures
	// reach the client on the timeline.
	if result.TokensAfter != 0 {
		t.Errorf("tokensAfter = %d, want 0 while the reclaim is in flight", result.TokensAfter)
	}
	if conv.compactCalls() != 1 {
		t.Errorf("provider called %d times, want 1", conv.compactCalls())
	}
}

// A provider with no way to reclaim context gets a typed answer, so the client can
// stop offering the control instead of surfacing an internal failure the user
// cannot act on. The plain fake conversation does not implement ChatCompactor.
func TestCompactOnAProviderThatCannotIsTyped(t *testing.T) {
	h := newHarness(t)

	_, err := h.svc.Compact(context.Background(), testSession)
	if !errors.Is(err, chatsvc.ErrCompactionUnsupported) {
		t.Fatalf("err = %v, want ErrCompactionUnsupported", err)
	}
}

// Measured twice against a live app-server: thread/compact/start mid-turn silently
// interrupts the running turn and reports it as interrupted, then compacts. Losing
// work the user is waiting on as a side effect of housekeeping is not something to
// discover afterwards from the timeline, so AO refuses and makes them stop it.
func TestCompactRefusesWhileATurnIsInFlight(t *testing.T) {
	conv := newCompactingConversation()
	h := newHarnessWithConversation(t, conv)
	ctx := context.Background()

	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "start something long", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if _, err := h.svc.Compact(ctx, testSession); !errors.Is(err, chatsvc.ErrCompactionWhileBusy) {
		t.Fatalf("err = %v, want ErrCompactionWhileBusy", err)
	}
	if conv.compactCalls() != 0 {
		t.Error("the provider was asked to compact anyway; the running turn would have been discarded")
	}

	// Once the turn settles it is allowed again.
	conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1",
		TurnState: domain.TurnStateCompleted,
	})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Turns) == 1 && s.Turns[0].State == domain.TurnStateCompleted
	})
	if _, err := h.svc.Compact(ctx, testSession); err != nil {
		t.Fatalf("Compact after the turn settled: %v", err)
	}
}

// A provider can start a turn AO never dispatched: a compaction runs as its own
// turn, and so does work the provider resumes from its own history. Without a row
// for it, every item that turn emits correlates to no turn — the activities arrive
// with an empty turn id and the timeline silently stops grouping them, which reads
// to a user as the conversation falling apart.
func TestProviderStartedTurnIsAdoptedSoItsItemsCorrelate(t *testing.T) {
	h := newHarness(t)

	// No Send: this turn is entirely the provider's doing.
	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-owned-1"},
		ports.ChatEvent{
			Kind: ports.ChatEventActivityCompleted, ProviderTurnID: "provider-owned-1",
			ProviderItemID: "exec-1", ActivityKind: domain.ActivityKindCommand,
			ActivityStatus: domain.ActivityStatusCompleted, Summary: "rg --files",
		},
		ports.ChatEvent{
			Kind: ports.ChatEventActivityCompleted, ProviderTurnID: "provider-owned-1",
			ProviderItemID: "exec-2", ActivityKind: domain.ActivityKindCommand,
			ActivityStatus: domain.ActivityStatusCompleted, Summary: "sed -n 1,40p x",
		},
	)

	snapshot := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return len(s.Activities) == 2
	})

	if len(snapshot.Turns) != 1 {
		t.Fatalf("turns = %d, want the provider's turn adopted", len(snapshot.Turns))
	}
	if got := snapshot.Turns[0].ProviderTurnID; got != "provider-owned-1" {
		t.Errorf("adopted turn provider id = %q", got)
	}
	for _, activity := range snapshot.Activities {
		if activity.TurnID == "" {
			t.Errorf("activity %q has no turn id; the timeline cannot group it", activity.Summary)
		}
	}
}
