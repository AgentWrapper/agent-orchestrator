package chat_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// historyRecorder is a provider double that CAN do the history operations, so a test
// can tell "the driver refuses" from "the driver does not offer this at all". The
// plain fakeConversation implements none of the three, which is what the unsupported
// paths exercise.
type historyRecorder struct {
	*fakeConversation

	mu           sync.Mutex
	rolledBack   []string
	titles       []string
	forkedTo     string
	rollbackErr  error
	setTitleErr  error
	forkErr      error
	echoRenameTo string
}

func newHistoryRecorder() *historyRecorder {
	return &historyRecorder{fakeConversation: newFakeConversation(), forkedTo: "thread-forked"}
}

func (h *historyRecorder) Rollback(_ context.Context, providerTurnID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rollbackErr != nil {
		return h.rollbackErr
	}
	h.rolledBack = append(h.rolledBack, providerTurnID)
	return nil
}

func (h *historyRecorder) Fork(context.Context) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.forkErr != nil {
		return "", h.forkErr
	}
	return h.forkedTo, nil
}

// SetTitle records the name and, like the real provider, reports it back on the event
// stream. That echo is the only path by which a title reaches AO's rows.
func (h *historyRecorder) SetTitle(_ context.Context, title string) error {
	h.mu.Lock()
	if h.setTitleErr != nil {
		err := h.setTitleErr
		h.mu.Unlock()
		return err
	}
	h.titles = append(h.titles, title)
	echo := h.echoRenameTo
	h.mu.Unlock()

	if echo == "" {
		echo = title
	}
	h.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: echo})
	return nil
}

func (h *historyRecorder) rollbackTargets() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.rolledBack...)
}

func (h *historyRecorder) setTitles() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.titles...)
}

// refusedError is what a driver returns when the provider itself declined. The
// service classifies it structurally, which is what keeps an ordinary "not right now"
// from surfacing as an internal failure.
type refusedError struct{ msg string }

func (e refusedError) Error() string     { return e.msg }
func (e refusedError) ChatRefusal() bool { return true }

// completeTurn sends a message and drives it to completion, leaving one settled turn.
func completeTurn(t *testing.T, h *harness, text, providerTurn string) string {
	t.Helper()
	turn, err := h.svc.Send(context.Background(), testSession, ports.ChatUserMessage{
		Text:   text,
		Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send %q: %v", text, err)
	}
	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: providerTurn},
		ports.ChatEvent{
			Kind: ports.ChatEventMessageCompleted, ProviderTurnID: providerTurn,
			ProviderItemID: "msg-" + providerTurn, Text: "reply to " + text,
		},
		ports.ChatEvent{
			Kind: ports.ChatEventTurnCompleted, ProviderTurnID: providerTurn,
			TurnState: domain.TurnStateCompleted,
		},
	)
	return turn.ID
}

// The end-to-end shape of an undo: the provider is asked to forget, and AO's timeline
// stops showing what it forgot.
func TestRollbackDiscardsTheTurnAndEverythingAfterIt(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second := completeTurn(t, h, "second", "provider-turn-2")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

	discarded, err := h.svc.Rollback(ctx, testSession, second)
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if discarded != 1 {
		t.Errorf("discarded = %d, want 1", discarded)
	}

	// The provider is named by ITS turn id, not AO's: they are different namespaces
	// and sending AO's would roll back nothing.
	if targets := recorder.rollbackTargets(); len(targets) != 1 || targets[0] != "provider-turn-2" {
		t.Fatalf("provider rollback targets = %v, want [provider-turn-2]", targets)
	}

	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if len(snapshot.Messages) != 2 {
		t.Fatalf("messages = %d, want only the surviving turn's pair", len(snapshot.Messages))
	}
	for _, msg := range snapshot.Messages {
		if strings.Contains(msg.Text, "second") {
			t.Errorf("discarded message still in the timeline: %q", msg.Text)
		}
	}
}

func TestRollbackRemovesLaterLegacyCompactionState(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second := completeTurn(t, h, "second", "provider-turn-2")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

	// Builds before compaction turn correlation shipped stored this boundary with
	// no turn_id. It still belongs to the history after the second prompt.
	compactedAt := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	if err := h.st.UpsertActivity(ctx, h.ctrl.ConversationID(), "", domain.ConversationActivity{
		ID: "legacy-compaction", Kind: domain.ActivityKindSystem,
		Status: domain.ActivityStatusCompleted, Summary: "Compacted history",
		Detail: []byte(`{"event":"compaction"}`), ProviderItemID: "legacy-compaction-item",
	}, compactedAt); err != nil {
		t.Fatalf("seed legacy compaction: %v", err)
	}
	if err := h.st.MarkCompacted(ctx, h.ctrl.ConversationID(), compactedAt); err != nil {
		t.Fatalf("mark compacted: %v", err)
	}

	if _, err := h.svc.Rollback(ctx, testSession, second); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if snapshot.Conversation.CompactedAt != nil {
		t.Fatalf("compactedAt = %v, want cleared after its history was rolled back", snapshot.Conversation.CompactedAt)
	}
	for _, activity := range snapshot.Activities {
		if activity.ID == "legacy-compaction" {
			t.Fatal("rolled-back legacy compaction remained visible")
		}
	}
}

// Refused, not raced. A rollback while the agent is mid-turn would leave AO hiding
// rows the agent is still writing into, so the check happens before the provider is
// asked at all.
func TestRollbackIsRefusedWhileATurnIsRunning(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	turnID := completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	// A second turn that never completes: the agent is working.
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "still going", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	_, err := h.svc.Rollback(ctx, testSession, turnID)
	if !errors.Is(err, chatsvc.ErrTurnRunning) {
		t.Fatalf("err = %v, want ErrTurnRunning", err)
	}
	if targets := recorder.rollbackTargets(); len(targets) != 0 {
		t.Fatalf("provider was asked to roll back mid-turn: %v", targets)
	}

	// Nothing was hidden either. A refused rollback must leave the timeline alone.
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	for _, turn := range snapshot.Turns {
		if turn.RolledBackAt != nil {
			t.Errorf("turn %s was marked rolled back by a refused rollback", turn.ID)
		}
	}
}

// A provider without the capability gets a typed answer the client can render as an
// absent affordance, following the Models precedent.
func TestRollbackReportsAnUnsupportedDriver(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	turnID := completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	_, err := h.svc.Rollback(ctx, testSession, turnID)
	if !errors.Is(err, chatsvc.ErrRollbackUnsupported) {
		t.Fatalf("err = %v, want ErrRollbackUnsupported", err)
	}
}

// A turn the provider never accepted holds no provider history. Hiding AO's rows for
// it would leave the agent remembering more than the timeline shows, which is the
// exact disagreement rollback exists to prevent.
func TestRollbackRefusesATurnTheProviderNeverAccepted(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	// Busy, so this one is recorded and queued rather than dispatched.
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "running", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("Send running: %v", err)
	}
	queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "queued", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send queued: %v", err)
	}
	if queued.State != domain.TurnStateQueued {
		t.Fatalf("second send state = %q, want queued", queued.State)
	}

	_, err = h.svc.Rollback(ctx, testSession, queued.ID)
	// It is refused, though which refusal depends on whether the running turn is
	// noticed first; both are honest and neither is a 500.
	if !errors.Is(err, chatsvc.ErrTurnNotRollbackable) && !errors.Is(err, chatsvc.ErrTurnRunning) {
		t.Fatalf("err = %v, want ErrTurnNotRollbackable or ErrTurnRunning", err)
	}
}

// A turn id from nowhere is a 404-shaped answer, not a conflict.
func TestRollbackReportsAnUnknownTurn(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	_, err := h.svc.Rollback(context.Background(), testSession, "turn-that-never-was")
	if !errors.Is(err, domain.ErrNoConversationTurn) {
		t.Fatalf("err = %v, want domain.ErrNoConversationTurn", err)
	}
}

// The provider's own refusal must arrive as a conflict carrying its explanation. A
// generic failure would tell the user nothing they could act on.
func TestRollbackClassifiesAProviderRefusal(t *testing.T) {
	recorder := newHistoryRecorder()
	recorder.rollbackErr = refusedError{msg: "Cannot rollback while a turn is in progress."}
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	turnID := completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	_, err := h.svc.Rollback(ctx, testSession, turnID)
	if !errors.Is(err, chatsvc.ErrProviderRefused) {
		t.Fatalf("err = %v, want ErrProviderRefused", err)
	}
	if !strings.Contains(err.Error(), "turn is in progress") {
		t.Errorf("err = %v, want the provider's explanation carried through", err)
	}

	// And AO hid nothing: the provider still remembers the turn.
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if len(snapshot.Messages) != 2 {
		t.Errorf("messages = %d, want the timeline untouched by a refused rollback",
			len(snapshot.Messages))
	}
}

// The title round trip: AO asks, the provider confirms on its own event, and only
// then does the session label move. Nothing is written optimistically.
func TestSetTitleFlowsThroughTheProviderIntoTheSessionName(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	title, err := h.svc.SetTitle(ctx, testSession, "## \"Fix OAuth Return URL Loss.\"  ")
	if err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	// Normalized before it ever reaches the provider: heading markers, wrapper
	// quotes and trailing punctuation are model habits, not part of the title.
	if title != "Fix OAuth Return URL Loss" {
		t.Fatalf("normalized title = %q", title)
	}
	if titles := recorder.setTitles(); len(titles) != 1 || titles[0] != title {
		t.Fatalf("provider received %v, want [%q]", titles, title)
	}

	awaitSessionName(t, h, "Fix OAuth Return URL Loss")

	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if snapshot.Conversation.ProviderTitle != "Fix OAuth Return URL Loss" {
		t.Errorf("provider title = %q", snapshot.Conversation.ProviderTitle)
	}
}

// A title AO never asked for still lands: another client naming the thread is how a
// provider-derived title arrives at all.
func TestAProviderRenameFromElsewhereNamesTheSession(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	h.conv.emit(ports.ChatEvent{
		Kind:  ports.ChatEventThreadRenamed,
		Title: "Restore Canvas Renderer Fallback",
	})
	awaitSessionName(t, h, "Restore Canvas Renderer Fallback")
}

// The rule the user cares about: their own name is never taken away by a model.
func TestAProviderTitleDoesNotOverwriteAUserRename(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	if renamed, err := h.st.RenameSession(ctx, testSession, "Mine", h.now()); err != nil || !renamed {
		t.Fatalf("rename: renamed=%v err=%v", renamed, err)
	}

	if _, err := h.svc.SetTitle(ctx, testSession, "Something Else Entirely"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}

	// The provider title is still recorded; only the label is left alone.
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.ProviderTitle == "Something Else Entirely"
	})
	rec, ok, err := h.st.GetSession(ctx, testSession)
	if err != nil || !ok {
		t.Fatalf("get session: ok=%v err=%v", ok, err)
	}
	if rec.DisplayName != "Mine" {
		t.Errorf("display name = %q, want the user's name to have survived", rec.DisplayName)
	}
}

// Clearing the thread name is not a reason to strip AO's label.
func TestAClearedProviderTitleLeavesTheSessionNameAlone(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: "First Name"})
	awaitSessionName(t, h, "First Name")

	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: ""})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.ProviderTitle == ""
	})

	rec, ok, err := h.st.GetSession(ctx, testSession)
	if err != nil || !ok {
		t.Fatalf("get session: ok=%v err=%v", ok, err)
	}
	if rec.DisplayName != "First Name" {
		t.Errorf("display name = %q, want the label kept when the thread lost its name",
			rec.DisplayName)
	}
}

func TestSetTitleRefusesABlankTitle(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	if _, err := h.svc.SetTitle(context.Background(), testSession, "  ###  "); !errors.Is(err, chatsvc.ErrTitleRequired) {
		t.Fatalf("err = %v, want ErrTitleRequired", err)
	}
	if titles := recorder.setTitles(); len(titles) != 0 {
		t.Fatalf("provider was asked to set %v", titles)
	}
}

func TestSetTitleReportsAnUnsupportedDriver(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.SetTitle(context.Background(), testSession, "A Name"); !errors.Is(err, chatsvc.ErrRenameUnsupported) {
		t.Fatalf("err = %v, want ErrRenameUnsupported", err)
	}
}

func TestForkReturnsTheNewProviderConversationID(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	forked, err := h.svc.ForkConversation(context.Background(), testSession)
	if err != nil {
		t.Fatalf("ForkConversation: %v", err)
	}
	if forked != "thread-forked" {
		t.Errorf("forked conversation = %q, want thread-forked", forked)
	}
}

func TestForkReportsAnUnsupportedDriver(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.ForkConversation(context.Background(), testSession); !errors.Is(err, chatsvc.ErrForkUnsupported) {
		t.Fatalf("err = %v, want ErrForkUnsupported", err)
	}
}

func TestForkClassifiesAProviderRefusal(t *testing.T) {
	recorder := newHistoryRecorder()
	recorder.forkErr = refusedError{msg: "lastTurnId identifies an in-progress turn"}
	h := newHarnessWithConversation(t, recorder)

	_, err := h.svc.ForkConversation(context.Background(), testSession)
	if !errors.Is(err, chatsvc.ErrProviderRefused) {
		t.Fatalf("err = %v, want ErrProviderRefused", err)
	}
}

// The contract from the automatic-semantic-task-titles design, applied to whatever
// the provider says rather than trusted.
func TestNormalizeTitle(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "Fix OAuth Return URL Loss", "Fix OAuth Return URL Loss"},
		{"heading marker", "## Review PR in Fresh Worktree", "Review PR in Fresh Worktree"},
		{"list marker", "- Restore Canvas Renderer Fallback", "Restore Canvas Renderer Fallback"},
		{"quoted", `"Fix the login redirect"`, "Fix the login redirect"},
		{"backticked", "`Rebuild the index`", "Rebuild the index"},
		{"trailing period", "Fix the login redirect.", "Fix the login redirect"},
		{"multi line keeps the first", "Fix the redirect\nand then some prose", "Fix the redirect"},
		{"collapses whitespace", "Fix   the    redirect", "Fix the redirect"},
		{"identifiers survive", "Fix OAuth callback in auth.go #3421", "Fix OAuth callback in auth.go #3421"},
		{"blank", "   ", ""},
		{"punctuation only", " -- ... ", ""},
		{
			"over length truncates at a word",
			strings.Repeat("alpha ", 20),
			"alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := chatsvc.NormalizeTitle(tc.in); got != tc.want {
				t.Errorf("NormalizeTitle(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// awaitSessionName polls until the label moves, because the title arrives on the
// projection goroutine rather than on the caller's.
func awaitSessionName(t *testing.T, h *harness, want string) {
	t.Helper()
	h.awaitSnapshot(t, func(store.ConversationSnapshot) bool {
		rec, ok, err := h.st.GetSession(context.Background(), testSession)
		return err == nil && ok && rec.DisplayName == want
	})
}
