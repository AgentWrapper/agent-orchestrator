package chat_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
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
	st, err := sqlite.Open(dir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

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

func newFakeConversation() *fakeConversation {
	return &fakeConversation{
		events:   make(chan ports.ChatEvent, 64),
		resolved: map[string]ports.ChatDecision{},
	}
}

func (f *fakeConversation) ProviderConversationID() string       { return "thread-1" }
func (f *fakeConversation) Capabilities() ports.ChatCapabilities { return productionCaps() }
func (f *fakeConversation) Events() <-chan ports.ChatEvent       { return f.events }

func (f *fakeConversation) SendTurn(context.Context, ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return ports.ChatTurnRef{}, f.sendErr
	}
	f.turnSeq++
	return ports.ChatTurnRef{ProviderTurnID: fmt.Sprintf("provider-turn-%d", f.turnSeq)}, nil
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

type fakeDriver struct{ conv *fakeConversation }

func (d fakeDriver) Harness() domain.AgentHarness { return domain.HarnessCodex }
func (d fakeDriver) Probe(context.Context) (ports.ChatCapabilities, error) {
	return productionCaps(), nil
}
func (d fakeDriver) Start(context.Context, ports.ChatStartConfig) (ports.ChatConversation, error) {
	return d.conv, nil
}
func (d fakeDriver) Resume(context.Context, ports.ChatResumeConfig) (ports.ChatConversation, error) {
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

/* ---- harness ----------------------------------------------------------- */

type harness struct {
	svc  *chatsvc.Service
	st   *sqlite.Store
	conv *fakeConversation
	ctrl *chatsvc.Controller
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	st := openStore(t)
	conv := newFakeConversation()

	var counter int
	svc := chatsvc.New(chatsvc.Options{
		Store:    st,
		Sessions: st,
		Drivers:  fakeRegistry{driver: fakeDriver{conv: conv}},
		Log:      slog.New(slog.DiscardHandler),
		NewID: func() string {
			counter++
			return fmt.Sprintf("id-%03d", counter)
		},
		Now: func() time.Time { return time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC) },
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

	return &harness{svc: svc, st: st, conv: conv, ctrl: ctrl}
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
		ports.ChatEvent{
			Kind: ports.ChatEventApprovalRequested, ProviderTurnID: "provider-turn-1",
			ProviderItemID: "0", RequestID: "0", ActivityKind: domain.ActivityKindCommand,
			ActivityStatus: domain.ActivityStatusPending, Summary: "Run something",
		},
	)
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Activities) == 1 })

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
	if got := snapshot.Activities[0].Status; got == domain.ActivityStatusPending {
		t.Error("approval left pending after its controller died — the user can never answer it")
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

func errorsIs(err, target error) bool {
	for err != nil {
		if err == target {
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
