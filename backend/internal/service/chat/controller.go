// Package chat owns the daemon side of a Chat-mode session: one controller per
// session, the projection of provider events into durable conversation rows, and
// the typed commands a client can issue against it.
//
// Ownership rules this package enforces:
//
//   - exactly one live controller per session, and it is the only writer to that
//     session's provider conversation;
//   - provider events are archived and projected together, so the raw record can
//     never disagree with the timeline derived from it;
//   - an event carrying a stale controller generation is dropped, so a controller
//     that is dying cannot mutate the session that replaced it;
//   - a turn left in flight when a controller ends settles as failed, because a
//     controller that stopped running a turn is not evidence the work finished.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Store is the durable conversation surface the controller needs. Implemented by
// the SQLite store.
type Store interface {
	CreateConversation(ctx context.Context, id string, project domain.ProjectID, session domain.SessionID, now time.Time) (domain.ConversationRecord, error)
	ConversationForSession(ctx context.Context, session domain.SessionID) (domain.ConversationRecord, error)

	AppendUserMessage(ctx context.Context, conversationID string, session domain.SessionID, generation string, msg domain.ConversationMessage, turnID string, now time.Time) (bool, error)
	BindTurnToProvider(ctx context.Context, turnID, providerTurnID string, now time.Time) error
	SettleTurn(ctx context.Context, conversationID, providerTurnID string, state domain.TurnState, errMessage string, now time.Time) error
	SettleOrphanedTurns(ctx context.Context, session domain.SessionID, now time.Time) error

	AppendAssistantDelta(ctx context.Context, conversationID, providerItemID, providerTurnID, delta, messageID string, now time.Time) error
	SettleAssistantMessage(ctx context.Context, conversationID, providerItemID, providerTurnID, text, messageID string, now time.Time) error

	UpsertActivity(ctx context.Context, conversationID, providerTurnID string, activity domain.ConversationActivity, now time.Time) error
	ResolveApproval(ctx context.Context, conversationID, requestID, detailJSON string, now time.Time) error
	FailPendingApprovals(ctx context.Context, conversationID string, now time.Time) error

	RecordProviderEvent(ctx context.Context, conversationID string, session domain.SessionID, providerEventID, method, payloadJSON string, now time.Time) error
}

// ActivityRecorder feeds derived session status.
//
// Chat reports activity through the SAME lifecycle reduction terminal sessions
// use, rather than persisting a second display status. Without it a chat session
// reads as idle while the agent is working, because the hook and terminal signals
// that normally drive activity never fire for a chat controller.
type ActivityRecorder interface {
	ApplyActivitySignal(ctx context.Context, id domain.SessionID, s ports.ActivitySignal) error
}

// IDFactory mints the identifiers AO assigns. Injected so tests get stable ids.
type IDFactory func() string

// Clock is injected so tests do not depend on wall time.
type Clock func() time.Time

// Controller drives one Chat session.
type Controller struct {
	sessionID    domain.SessionID
	conversation domain.ConversationRecord
	generation   string

	conv     ports.ChatConversation
	store    Store
	activity ActivityRecorder
	log      *slog.Logger
	newID    IDFactory
	now      Clock

	// sendMu serializes command dispatch so only one operation mutates the
	// provider conversation at a time.
	sendMu sync.Mutex

	mu sync.Mutex
	// activeTurn maps a provider turn id to AO's turn id for the turn currently
	// in flight, so a completion can be attributed without a round trip.
	pendingTurnID string
	state         ports.ChatControllerState

	stopped chan struct{}
	once    sync.Once
}

// ErrNoActiveTurn reports an interrupt with nothing to cancel.
var ErrNoActiveTurn = errors.New("no active turn")

func newController(
	sessionID domain.SessionID,
	conversation domain.ConversationRecord,
	generation string,
	conv ports.ChatConversation,
	store Store,
	activity ActivityRecorder,
	log *slog.Logger,
	newID IDFactory,
	now Clock,
) *Controller {
	c := &Controller{
		sessionID:    sessionID,
		conversation: conversation,
		generation:   generation,
		conv:         conv,
		store:        store,
		activity:     activity,
		log:          log,
		newID:        newID,
		now:          now,
		state:        ports.ChatControllerReady,
		stopped:      make(chan struct{}),
	}
	go c.project()
	return c
}

// ProviderConversationID is the handle to persist for resume.
func (c *Controller) ProviderConversationID() string { return c.conv.ProviderConversationID() }

// ConversationID is the durable conversation this controller writes to.
func (c *Controller) ConversationID() string { return c.conversation.ID }

// Generation fences events from a controller that has been replaced.
func (c *Controller) Generation() string { return c.generation }

// State reports controller health.
func (c *Controller) State() ports.ChatControllerState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// Send records a message and dispatches it to the provider.
//
// The durable record is written first: if the provider call then fails, the user
// can see their message and its delivery state rather than having it vanish. A
// retry carrying the same client message id is a no-op, so a flaky client cannot
// produce two provider turns.
func (c *Controller) Send(ctx context.Context, msg ports.ChatUserMessage) (domain.ConversationTurn, error) {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	now := c.now()
	turnID := c.newID()
	record := domain.ConversationMessage{
		ID:              c.newID(),
		Text:            msg.Text,
		Origin:          normalizeOrigin(msg.Origin),
		ClientMessageID: msg.ClientMessageID,
	}

	created, err := c.store.AppendUserMessage(
		ctx, c.conversation.ID, c.sessionID, c.generation, record, turnID, now)
	if err != nil {
		return domain.ConversationTurn{}, fmt.Errorf("record user message: %w", err)
	}
	if !created {
		// Already delivered under this client message id. Returning the empty turn
		// signals "nothing new happened" without claiming a second dispatch.
		c.log.Debug("duplicate chat send ignored",
			"session", c.sessionID, "clientMessageId", msg.ClientMessageID)
		return domain.ConversationTurn{}, nil
	}

	ref, err := c.conv.SendTurn(ctx, msg)
	if err != nil {
		// The provider may or may not have accepted it. Settle the turn as failed
		// rather than retrying: a duplicate turn would run the work twice.
		if settleErr := c.store.SettleTurn(
			ctx, c.conversation.ID, "", domain.TurnStateFailed, err.Error(), c.now()); settleErr != nil {
			c.log.Error("failed to settle turn after send error", "error", settleErr)
		}
		return domain.ConversationTurn{}, fmt.Errorf("send turn: %w", err)
	}

	if err := c.store.BindTurnToProvider(ctx, turnID, ref.ProviderTurnID, c.now()); err != nil {
		return domain.ConversationTurn{}, fmt.Errorf("bind turn: %w", err)
	}

	c.mu.Lock()
	c.pendingTurnID = ref.ProviderTurnID
	c.mu.Unlock()

	return domain.ConversationTurn{
		ID:                 turnID,
		ConversationID:     c.conversation.ID,
		HandledBySessionID: c.sessionID,
		ProviderTurnID:     ref.ProviderTurnID,
		State:              domain.TurnStateRunning,
		RequestedAt:        now,
	}, nil
}

// Resolve answers a pending approval. The provider is told first: if it rejects
// the decision, AO must not have already recorded the approval as answered.
func (c *Controller) Resolve(ctx context.Context, requestID string, decision ports.ChatDecision) error {
	if err := c.conv.ResolveRequest(ctx, requestID, decision); err != nil {
		return fmt.Errorf("resolve request %s: %w", requestID, err)
	}
	detail, _ := json.Marshal(map[string]string{"decision": decision.ID})
	if err := c.store.ResolveApproval(
		ctx, c.conversation.ID, requestID, string(detail), c.now()); err != nil {
		return fmt.Errorf("record approval %s: %w", requestID, err)
	}
	return nil
}

// Interrupt cancels the in-flight turn.
func (c *Controller) Interrupt(ctx context.Context) error {
	c.mu.Lock()
	turn := c.pendingTurnID
	c.mu.Unlock()
	if turn == "" {
		return ErrNoActiveTurn
	}
	if err := c.conv.Interrupt(ctx, turn); err != nil {
		return fmt.Errorf("interrupt turn %s: %w", turn, err)
	}
	return nil
}

// Close releases the controller. Settling in-flight work is not done here: it
// happens when the event stream ends, which covers a provider that died on its
// own as well as a shutdown AO initiated. Close only has to make the stream end
// and wait for that to finish.
func (c *Controller) Close(context.Context) error {
	c.once.Do(func() {
		_ = c.conv.Close()
		<-c.stopped
	})
	return nil
}

// Wait blocks until the controller's event stream has ended.
func (c *Controller) Wait() { <-c.stopped }

// project consumes the driver's normalized events and writes them down. It runs
// until the driver's stream closes, which happens when the provider process ends.
func (c *Controller) project() {
	defer close(c.stopped)

	// Detached from any request context: this outlives the call that started the
	// controller, and must keep persisting until the provider stream ends.
	ctx := context.WithoutCancel(context.Background())

	for event := range c.conv.Events() {
		c.archive(ctx, event)
		if err := c.apply(ctx, event); err != nil {
			// A projection failure must not kill the stream: the raw event is
			// already archived, so the timeline can be repaired later.
			c.log.Error("failed to project chat event",
				"session", c.sessionID, "kind", event.Kind, "error", err)
		}
	}

	c.mu.Lock()
	c.state = ports.ChatControllerStopped
	c.mu.Unlock()

	// The stream has ended, so nothing more can arrive for this controller. This
	// is the only place that reliably knows that — a provider process can die on
	// its own, in which case no AO code path called Close — so it is where
	// in-flight work gets settled.
	//
	// A turn the controller was running is not evidence the work finished, and an
	// approval still pending can never be answered because the provider call it
	// was blocking is gone. Both are closed out honestly rather than left looking
	// live forever.
	now := c.now()
	if err := c.store.SettleOrphanedTurns(ctx, c.sessionID, now); err != nil {
		c.log.Error("failed to settle orphaned turns", "session", c.sessionID, "error", err)
	}
	if err := c.store.FailPendingApprovals(ctx, c.conversation.ID, now); err != nil {
		c.log.Error("failed to close pending approvals", "session", c.sessionID, "error", err)
	}
}

// archive records the raw event. This is what makes a projection bug recoverable:
// without it, a wrong projection is the only surviving account of what happened.
func (c *Controller) archive(ctx context.Context, event ports.ChatEvent) {
	payload, err := json.Marshal(map[string]any{
		"kind":           event.Kind,
		"providerTurnId": event.ProviderTurnID,
		"providerItemId": event.ProviderItemID,
		"summary":        event.Summary,
		"detail":         json.RawMessage(nonEmptyJSON(event.Detail)),
		"requestId":      event.RequestID,
		"turnState":      event.TurnState,
	})
	if err != nil {
		c.log.Error("failed to encode provider event for archive", "error", err)
		return
	}
	// Provider event ids are only stable for some events; where absent the row is
	// kept unconditionally rather than dropped, since the archive's job is
	// completeness.
	if err := c.store.RecordProviderEvent(ctx, c.conversation.ID, c.sessionID,
		event.ProviderItemID, string(event.Kind), string(payload), c.now()); err != nil {
		c.log.Error("failed to archive provider event", "error", err)
	}
}

func (c *Controller) apply(ctx context.Context, event ports.ChatEvent) error {
	now := c.now()

	switch event.Kind {
	case ports.ChatEventTurnStarted:
		c.mu.Lock()
		c.pendingTurnID = event.ProviderTurnID
		c.state = ports.ChatControllerBusy
		c.mu.Unlock()
		c.reportActivity(ctx, domain.ActivityActive, "chat.turn.started", now)
		return nil

	case ports.ChatEventTurnCompleted:
		c.mu.Lock()
		if c.pendingTurnID == event.ProviderTurnID {
			c.pendingTurnID = ""
		}
		c.state = ports.ChatControllerReady
		c.mu.Unlock()
		message := ""
		if event.Err != nil {
			message = event.Err.Error()
		}
		state := event.TurnState
		if state == "" {
			// A completion with no status is not evidence of success.
			state = domain.TurnStateFailed
		}
		// The turn is over, so the session is waiting on the user again.
		c.reportActivity(ctx, domain.ActivityIdle, "chat.turn.completed", now)
		return c.store.SettleTurn(ctx, c.conversation.ID, event.ProviderTurnID, state, message, now)

	case ports.ChatEventMessageDelta:
		return c.store.AppendAssistantDelta(ctx, c.conversation.ID,
			event.ProviderItemID, event.ProviderTurnID, event.Delta, c.newID(), now)

	case ports.ChatEventMessageCompleted:
		return c.store.SettleAssistantMessage(ctx, c.conversation.ID,
			event.ProviderItemID, event.ProviderTurnID, event.Text, c.newID(), now)

	case ports.ChatEventActivityStarted, ports.ChatEventActivityCompleted:
		return c.store.UpsertActivity(ctx, c.conversation.ID, event.ProviderTurnID,
			domain.ConversationActivity{
				ID:             c.newID(),
				Kind:           event.ActivityKind,
				Status:         event.ActivityStatus,
				Summary:        event.Summary,
				Detail:         event.Detail,
				ProviderItemID: event.ProviderItemID,
			}, now)

	case ports.ChatEventApprovalRequested:
		// Blocked on a person, which is distinct from working and from idle: the
		// board should surface it as needing attention.
		c.reportActivity(ctx, domain.ActivityWaitingInput, "chat.approval.requested", now)
		detail := mergeApprovalDetail(event)
		return c.store.UpsertActivity(ctx, c.conversation.ID, event.ProviderTurnID,
			domain.ConversationActivity{
				ID:             c.newID(),
				Kind:           domain.ActivityKindApproval,
				Status:         domain.ActivityStatusPending,
				Summary:        event.Summary,
				Detail:         detail,
				RequestID:      event.RequestID,
				ProviderItemID: event.ProviderItemID,
			}, now)

	case ports.ChatEventApprovalResolved:
		// The provider resolved it, possibly through another client. Mark it so a
		// card still on screen elsewhere stops being actionable.
		detail, _ := json.Marshal(map[string]string{"resolvedBy": "provider"})
		return c.store.ResolveApproval(ctx, c.conversation.ID, event.RequestID, string(detail), now)

	case ports.ChatEventControllerState:
		c.mu.Lock()
		c.state = event.ControllerState
		c.mu.Unlock()
		if event.ControllerState == ports.ChatControllerStopped {
			c.reportActivity(ctx, domain.ActivityExited, "chat.controller.stopped", now)
			if err := c.store.SettleOrphanedTurns(ctx, c.sessionID, now); err != nil {
				return err
			}
			return c.store.FailPendingApprovals(ctx, c.conversation.ID, now)
		}
		return nil

	case ports.ChatEventError:
		message := "provider error"
		if event.Err != nil {
			message = event.Err.Error()
		}
		detail, _ := json.Marshal(map[string]string{"error": message})
		return c.store.UpsertActivity(ctx, c.conversation.ID, event.ProviderTurnID,
			domain.ConversationActivity{
				ID:      c.newID(),
				Kind:    domain.ActivityKindError,
				Status:  domain.ActivityStatusFailed,
				Summary: message,
				Detail:  detail,
			}, now)

	default:
		// An event kind this build does not model is archived but not projected.
		return nil
	}
}

// mergeApprovalDetail folds the provider's offered decisions into the activity
// payload, so the client renders buttons from what the provider actually allows
// rather than from a fixed set.
func mergeApprovalDetail(event ports.ChatEvent) []byte {
	merged := map[string]any{}
	if len(event.Detail) > 0 {
		_ = json.Unmarshal(event.Detail, &merged)
	}
	decisions := make([]map[string]string, 0, len(event.Decisions))
	for _, option := range event.Decisions {
		decisions = append(decisions, map[string]string{"id": option.ID, "label": option.Label})
	}
	merged["decisions"] = decisions
	encoded, err := json.Marshal(merged)
	if err != nil {
		return event.Detail
	}
	return encoded
}

func normalizeOrigin(origin domain.MessageOrigin) domain.MessageOrigin {
	switch origin {
	case domain.MessageOriginHuman, domain.MessageOriginAutomation,
		domain.MessageOriginDaemon, domain.MessageOriginProvider:
		return origin
	default:
		return domain.MessageOriginHuman
	}
}

func nonEmptyJSON(raw []byte) []byte {
	if len(raw) == 0 {
		return []byte("null")
	}
	return raw
}

// reportActivity feeds the lifecycle reduction that derives user-facing status.
//
// Chat uses the same pipeline terminal sessions use rather than persisting a
// second display status — AO derives status from durable facts at read time, and
// a parallel chat-only status would be a second source of truth to keep in sync.
//
// Best-effort: a rejected signal must not stop the durable projection, which is
// the record that actually matters. Lifecycle also rejects signals it considers
// stale, which is a legitimate outcome rather than an error to surface.
func (c *Controller) reportActivity(
	ctx context.Context,
	state domain.ActivityState,
	event string,
	now time.Time,
) {
	if c.activity == nil {
		return
	}
	if err := c.activity.ApplyActivitySignal(ctx, c.sessionID, ports.ActivitySignal{
		Valid:     true,
		State:     state,
		Timestamp: now,
		Event:     event,
	}); err != nil {
		c.log.Debug("chat activity signal rejected",
			"session", c.sessionID, "event", event, "error", err)
	}
}
