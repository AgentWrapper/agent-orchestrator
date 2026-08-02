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
	SettleTurnByID(ctx context.Context, turnID string, state domain.TurnState, errMessage string, now time.Time) error
	SettleOrphanedTurns(ctx context.Context, session domain.SessionID, now time.Time) error

	SetConversationSettings(ctx context.Context, conversationID string, settings domain.ConversationSettings, now time.Time) error

	// Usage and rate limits are current state, not timeline entries: each write
	// replaces the last. The provider reports usage after every tool call, so an
	// append-per-report is what buried the conversation the first time round.
	RecordUsage(ctx context.Context, conversationID string, usage domain.ConversationUsage) error
	RecordRateLimits(ctx context.Context, conversationID string, limits domain.ConversationRateLimits) error

	NextQueuedTurn(ctx context.Context, conversationID string) (domain.QueuedTurn, error)
	CancelQueuedTurns(ctx context.Context, conversationID string, cutoff, now time.Time) error

	AppendAssistantDelta(ctx context.Context, conversationID, providerItemID, providerTurnID, delta, messageID string, now time.Time) error
	SettleAssistantMessage(ctx context.Context, conversationID, providerItemID, providerTurnID, text, messageID string, now time.Time) error

	AppendCommandOutput(ctx context.Context, conversationID, providerItemID, delta string, now time.Time) (bool, error)
	SetTurnDiff(ctx context.Context, conversationID, providerTurnID string, diff domain.ConversationTurnDiff, now time.Time) (bool, error)

	UpsertActivity(ctx context.Context, conversationID, providerTurnID string, activity domain.ConversationActivity, now time.Time) error
	MarkCompacted(ctx context.Context, conversationID string, at time.Time) error
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
	// ackedTurnID is the turn the PROVIDER has confirmed it started, which lags
	// pendingTurnID by the round trip between turn/start returning and the
	// turn-started notification arriving. Interrupt needs the distinction: a
	// provider refuses to cancel a turn it has not acknowledged yet.
	ackedTurnID string
	state       ports.ChatControllerState
	// settings are the provider choices applied to the next dispatch. Held here as
	// well as on disk so a dispatch does not need a read, and updated together with
	// the row so the two cannot drift.
	settings domain.ConversationSettings
	// cancelQueuedAt is set when the user interrupts, and is the cutoff for the
	// queue that interrupt cancels. Zero means nothing is being cancelled.
	cancelQueuedAt time.Time

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
		settings:     conversation.Settings,
		stopped:      make(chan struct{}),
	}
	go c.project()
	go c.readRateLimits()
	return c
}

// rateLimitReadTimeout bounds the startup quota read. It is a local IPC call, and
// a provider that cannot answer it quickly must not hold up a conversation.
const rateLimitReadTimeout = 10 * time.Second

// readRateLimits seeds the account's quota position when the controller opens.
//
// The provider only pushes account/rateLimits/updated alongside a turn, which is
// too late for the thing this signal is for: a user wants to know they are near a
// wall BEFORE spending a turn discovering it. Reading once at startup closes that
// gap without giving clients a provider RPC to poll.
//
// Off the critical path on purpose, and failure is logged rather than surfaced: a
// conversation whose quota AO could not read is entirely usable, and refusing to
// start one over a missing readout would be a worse outcome than showing no meter.
func (c *Controller) readRateLimits() {
	reporter, ok := c.conv.(ports.ChatUsageReporter)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), rateLimitReadTimeout)
	defer cancel()

	limits, err := reporter.ReadRateLimits(ctx)
	if err != nil {
		c.log.Debug("chat rate limit read failed", "session", c.sessionID, "error", err)
		return
	}
	// Racing a pushed update is benign: both come from the same provider, and these
	// are percentages of a multi-day window that barely move between two reads
	// seconds apart.
	if err := c.store.RecordRateLimits(ctx, c.conversation.ID, domain.ConversationRateLimits{
		PrimaryUsedPercent:       limits.PrimaryUsedPercent,
		SecondaryUsedPercent:     limits.SecondaryUsedPercent,
		PrimaryResetsInSeconds:   limits.PrimaryResetsInSeconds,
		SecondaryResetsInSeconds: limits.SecondaryResetsInSeconds,
		PlanLabel:                limits.PlanLabel,
	}); err != nil {
		c.log.Debug("failed to record chat rate limits", "session", c.sessionID, "error", err)
	}
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

// Send records a message and dispatches it, or queues it if the agent is busy.
//
// The durable record is written first: if the provider call then fails, the user
// can see their message and its delivery state rather than having it vanish. A
// retry carrying the same client message id is a no-op, so a flaky client cannot
// produce two provider turns.
//
// A message that arrives mid-turn stays queued rather than being pushed at the
// provider. Two reasons: the agent is a single conversation and a second
// concurrent turn is not a thing it can run, and a queued row is a promise AO can
// keep across a restart, which a message dropped into a busy provider is not.
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

	if c.busy() {
		// AppendUserMessage wrote it as queued, which is exactly where it belongs
		// until the running turn ends. drain picks it up from there.
		return domain.ConversationTurn{
			ID:                 turnID,
			ConversationID:     c.conversation.ID,
			HandledBySessionID: c.sessionID,
			State:              domain.TurnStateQueued,
			RequestedAt:        now,
		}, nil
	}

	return c.dispatch(ctx, turnID, msg, now)
}

// Settings reports the provider choices for the next turn.
func (c *Controller) Settings() domain.ConversationSettings {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.settings
}

// SetSettings records the provider choices for the next turn.
//
// The row is written first: if that fails, the in-memory copy must not move, or a
// restart would silently revert a choice the user watched take effect.
func (c *Controller) SetSettings(ctx context.Context, settings domain.ConversationSettings) error {
	if err := c.store.SetConversationSettings(ctx, c.conversation.ID, settings, c.now()); err != nil {
		return fmt.Errorf("record conversation settings: %w", err)
	}
	c.mu.Lock()
	c.settings = settings
	c.mu.Unlock()
	return nil
}

// turnSettings converts the stored choices into what a driver takes per turn.
func (c *Controller) turnSettings() ports.ChatTurnSettings {
	current := c.Settings()
	return ports.ChatTurnSettings{
		Model:    current.Model,
		Effort:   current.ReasoningEffort,
		Approval: ports.PermissionMode(current.ApprovalMode),
	}
}

// busy reports whether a provider turn is in flight.
func (c *Controller) busy() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pendingTurnID != ""
}

// dispatch hands a recorded turn to the provider. Callers must hold sendMu.
func (c *Controller) dispatch(
	ctx context.Context,
	turnID string,
	msg ports.ChatUserMessage,
	requestedAt time.Time,
) (domain.ConversationTurn, error) {
	// Every dispatch carries the conversation's choices, including one AO makes on
	// the user's behalf: a queued message draining, or a relay from `ao send`. A
	// setting that only applied when the user pressed send would silently stop
	// applying exactly when they were not watching.
	msg.Settings = c.turnSettings()

	ref, err := c.conv.SendTurn(ctx, msg)
	if err != nil {
		// The provider may or may not have accepted it. Settle the turn as failed
		// rather than retrying: a duplicate turn would run the work twice. Settling
		// by AO's own turn id is required here — an undispatched turn has no
		// provider id, so looking one up by the empty string would hit whichever
		// undispatched turn the database returned first.
		if settleErr := c.store.SettleTurnByID(
			ctx, turnID, domain.TurnStateFailed, err.Error(), c.now()); settleErr != nil {
			c.log.Error("failed to settle turn after send error", "error", settleErr)
		}
		return domain.ConversationTurn{}, fmt.Errorf("send turn: %w", err)
	}

	if err := c.store.BindTurnToProvider(ctx, turnID, ref.ProviderTurnID, c.now()); err != nil {
		return domain.ConversationTurn{}, fmt.Errorf("bind turn: %w", err)
	}

	c.mu.Lock()
	c.pendingTurnID = ref.ProviderTurnID
	// Dispatched, not yet acknowledged: turn/start returning is AO's fact, and the
	// provider's own turn-started notification is the one an interrupt needs.
	c.ackedTurnID = ""
	c.mu.Unlock()

	return domain.ConversationTurn{
		ID:                 turnID,
		ConversationID:     c.conversation.ID,
		HandledBySessionID: c.sessionID,
		ProviderTurnID:     ref.ProviderTurnID,
		State:              domain.TurnStateRunning,
		RequestedAt:        requestedAt,
	}, nil
}

// drain sends the next queued message now that the agent is free.
//
// Runs on the projection goroutine, so it observes turn completion in order with
// everything else the provider said. One message per call: the turn it starts
// makes the controller busy again, and the next completion drains the next.
func (c *Controller) drain(ctx context.Context) {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	c.mu.Lock()
	cutoff := c.cancelQueuedAt
	c.cancelQueuedAt = time.Time{}
	busy := c.pendingTurnID != ""
	c.mu.Unlock()

	if busy {
		// Something already claimed the agent, so this drain has nothing to do.
		return
	}

	if !cutoff.IsZero() {
		// The user stopped the agent. Everything queued at that moment is
		// cancelled; anything typed afterwards is still theirs to send, and falls
		// through to the dispatch below.
		if err := c.store.CancelQueuedTurns(ctx, c.conversation.ID, cutoff, c.now()); err != nil {
			c.log.Error("failed to cancel queued turns", "session", c.sessionID, "error", err)
			return
		}
	}

	queued, err := c.store.NextQueuedTurn(ctx, c.conversation.ID)
	if errors.Is(err, domain.ErrNoQueuedTurn) {
		return
	}
	if err != nil {
		c.log.Error("failed to read queued turn", "session", c.sessionID, "error", err)
		return
	}

	if _, err := c.dispatch(ctx, queued.TurnID, ports.ChatUserMessage{
		Text:            queued.Text,
		Origin:          queued.Origin,
		ClientMessageID: queued.ClientMessageID,
	}, c.now()); err != nil {
		// dispatch already settled this turn as failed. Stopping here rather than
		// walking the rest of the queue: whatever broke the send is likely to break
		// the next one too, and failing them all on one bad provider state would
		// discard messages the user can otherwise still see waiting.
		c.log.Error("failed to dispatch queued turn",
			"session", c.sessionID, "turn", queued.TurnID, "error", err)
	}
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

// ErrCompactionUnsupported reports a driver whose provider cannot summarize
// history. Distinct from a failed compaction: "this agent has no way to reclaim
// context" is a permanent answer a client should stop offering, not something to
// retry.
var ErrCompactionUnsupported = errors.New("chat driver cannot compact history")

// ErrCompactionWhileBusy reports a compaction requested while a turn is running.
//
// Refused rather than forwarded because of what the provider does with it:
// `thread/compact/start` mid-turn silently INTERRUPTS the running turn, reports it
// as interrupted, and then compacts. Measured twice against a live app-server.
// Losing work the user is waiting on as a side effect of a housekeeping action is
// not something they should discover afterwards from the timeline, so AO makes them
// stop the turn themselves.
var ErrCompactionWhileBusy = errors.New("cannot compact while a turn is in flight")

// Compact summarizes earlier history to reclaim context.
//
// Without it a long conversation eventually cannot accept another turn at all:
// every turn re-sends the history, so context fills whether or not the user is
// doing anything unusual.
//
// It takes sendMu for the same reason a dispatch does, and the reason matters here:
// the busy check and the provider call have to be one step. Split, a message
// arriving in between would start a turn that the compaction then destroys — the
// exact outcome the check exists to prevent.
//
// The lock is released as soon as the provider accepts. The compaction itself runs
// as a provider turn for the next ten seconds or so, and holding sendMu across that
// would make the whole conversation unresponsive; the provider's own single-turn
// rule is what keeps a send from landing mid-compaction, and a send that arrives
// then queues behind the compaction turn like any other.
func (c *Controller) Compact(ctx context.Context) (ports.ChatCompactionResult, error) {
	compactor, ok := c.conv.(ports.ChatCompactor)
	if !ok {
		return ports.ChatCompactionResult{}, ErrCompactionUnsupported
	}

	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	if c.busy() {
		return ports.ChatCompactionResult{}, ErrCompactionWhileBusy
	}
	return compactor.Compact(ctx)
}

// turnAckWait bounds how long Interrupt waits for the provider to acknowledge a
// turn it has only just been handed.
//
// Stop appears the instant a message is sent, so a user can press it before the
// provider has started the turn — and a provider refuses to cancel a turn it does
// not yet consider active. Waiting out that gap is what makes the button reliable
// in the moment someone is most likely to use it: right after realizing they sent
// the wrong thing.
const turnAckWait = 3 * time.Second

// Interrupt cancels the in-flight turn, and with it anything queued behind it.
//
// The queue is cancelled because stop is the user's brake: a brake that releases
// the next message instead of stopping would be the opposite of what the button
// says. The cutoff is recorded before the provider call, so a completion that
// races back cannot drain the queue the interrupt was about to cancel.
func (c *Controller) Interrupt(ctx context.Context) error {
	turn, ok := c.awaitAcknowledgedTurn(ctx)
	if !ok {
		return ErrNoActiveTurn
	}

	c.mu.Lock()
	c.cancelQueuedAt = c.now()
	c.mu.Unlock()

	if err := c.conv.Interrupt(ctx, turn); err != nil {
		// The interrupt did not happen, so the queue it was going to cancel is
		// still the user's to send.
		c.mu.Lock()
		c.cancelQueuedAt = time.Time{}
		c.mu.Unlock()
		if errors.Is(err, ports.ErrChatNoActiveTurn) {
			return ErrNoActiveTurn
		}
		return fmt.Errorf("interrupt turn %s: %w", turn, err)
	}
	return nil
}

// awaitAcknowledgedTurn returns the turn to interrupt once the provider has
// confirmed it started, or reports that there is nothing to cancel.
//
// It gives up immediately when no turn is in flight — that is a plain "nothing to
// stop" and must stay fast. It only waits in the narrow window where AO has
// dispatched a turn and the provider has not yet said so. On expiry it returns the
// turn anyway: the provider is the authority on whether it can be cancelled, and
// its refusal is already translated into a typed answer.
func (c *Controller) awaitAcknowledgedTurn(ctx context.Context) (string, bool) {
	deadline := time.Now().Add(turnAckWait)
	for {
		c.mu.Lock()
		pending, acked := c.pendingTurnID, c.ackedTurnID
		c.mu.Unlock()

		if pending == "" {
			return "", false
		}
		if acked == pending || time.Now().After(deadline) {
			return pending, true
		}

		select {
		case <-ctx.Done():
			return pending, true
		case <-c.stopped:
			return pending, true
		case <-time.After(20 * time.Millisecond):
		}
	}
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
	record := map[string]any{
		"kind":           event.Kind,
		"providerTurnId": event.ProviderTurnID,
		"providerItemId": event.ProviderItemID,
		"summary":        event.Summary,
		"detail":         json.RawMessage(nonEmptyJSON(event.Detail)),
		"requestId":      event.RequestID,
		"turnState":      event.TurnState,
	}
	if event.Diff != nil {
		// A turn diff is low-frequency and IS the payload, so archiving it is what
		// makes a wrong diff projection recoverable. Deltas are deliberately not
		// archived by content: they arrive many times per command, and doubling that
		// write volume to duplicate text the projection already accumulates would
		// cost more than it could ever repay.
		record["diff"] = event.Diff
	}
	payload, err := json.Marshal(record)
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
		// The provider has confirmed this turn, so it will accept an interrupt for
		// it. Until this arrives, it will not.
		c.ackedTurnID = event.ProviderTurnID
		c.state = ports.ChatControllerBusy
		c.mu.Unlock()
		c.reportActivity(ctx, domain.ActivityActive, "chat.turn.started", now)
		return nil

	case ports.ChatEventTurnCompleted:
		c.mu.Lock()
		if c.pendingTurnID == event.ProviderTurnID {
			c.pendingTurnID = ""
		}
		if c.ackedTurnID == event.ProviderTurnID {
			c.ackedTurnID = ""
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
		if err := c.store.SettleTurn(
			ctx, c.conversation.ID, event.ProviderTurnID, state, message, now); err != nil {
			return err
		}
		// The agent is free: send whatever the user typed while it was busy. After
		// the settle, so a drain can never dispatch on top of a turn that still
		// looks live.
		c.drain(ctx)
		return nil

	case ports.ChatEventMessageDelta:
		return c.store.AppendAssistantDelta(ctx, c.conversation.ID,
			event.ProviderItemID, event.ProviderTurnID, event.Delta, c.newID(), now)

	case ports.ChatEventMessageCompleted:
		return c.store.SettleAssistantMessage(ctx, c.conversation.ID,
			event.ProviderItemID, event.ProviderTurnID, event.Text, c.newID(), now)

	case ports.ChatEventCommandOutputDelta:
		// Appended to the command's own activity row, not added to the timeline: a
		// row per delta would bury the conversation under one noisy command.
		//
		// A delta whose activity does not exist yet is dropped. The provider can
		// emit output before the item/started that creates the row, and inventing an
		// activity from a delta would mint a timeline entry with no command on it.
		found, err := c.store.AppendCommandOutput(ctx, c.conversation.ID,
			event.ProviderItemID, event.Delta, now)
		if err != nil {
			return err
		}
		if !found {
			c.log.Debug("command output delta had no activity to append to",
				"session", c.sessionID, "item", event.ProviderItemID)
		}
		return nil

	case ports.ChatEventTurnDiff:
		// Per-turn state, overwritten. The provider re-sends the whole diff on every
		// update, so appending a timeline row per notification would show the same
		// edits over and over as if they had happened repeatedly.
		if event.Diff == nil {
			return nil
		}
		diff := domain.ConversationTurnDiff{
			Truncated: event.Summary == domain.ChatDiffTruncatedSummary,
			Files:     make([]domain.ConversationDiffFile, 0, len(event.Diff.Files)),
		}
		for _, file := range event.Diff.Files {
			diff.Files = append(diff.Files, domain.ConversationDiffFile{
				Path:      file.Path,
				Additions: file.Additions,
				Deletions: file.Deletions,
				Status:    file.Status,
				OldPath:   file.OldPath,
			})
		}
		found, err := c.store.SetTurnDiff(ctx, c.conversation.ID, event.ProviderTurnID, diff, now)
		if err != nil {
			return err
		}
		if !found {
			// A turn from before this controller existed, seen after a restart.
			c.log.Debug("turn diff had no turn to attach to",
				"session", c.sessionID, "providerTurn", event.ProviderTurnID)
		}
		return nil

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

	case ports.ChatEventCompacted:
		// A fact about the conversation, not about a turn: the provider ran it in a
		// turn of its own that AO never dispatched, so binding the row to that turn
		// would file the entry under work the user never asked for. Passing no
		// provider turn id leaves turn_id NULL, which puts it in the timeline between
		// the turns it separates rather than inside one of them.
		//
		// Recorded because it is the one thing the timeline cannot show without a
		// row: after a restart the reclaim figures are gone from memory, and a
		// conversation that silently lost half its history with nothing to mark where
		// reads as if the agent simply forgot.
		if err := c.store.UpsertActivity(ctx, c.conversation.ID, "",
			domain.ConversationActivity{
				ID:     c.newID(),
				Kind:   domain.ActivityKindSystem,
				Status: domain.ActivityStatusCompleted,
				// Falls back to a plain label rather than an empty row: a driver that
				// reports a compaction without a summary still happened.
				Summary: firstNonEmpty(event.Summary, "Compacted the conversation history"),
				Detail:  compactionDetail(event),
				// The provider's own item id, so a compaction replayed across a
				// reconnect updates the existing row instead of adding a second.
				ProviderItemID: event.ProviderItemID,
			}, now); err != nil {
			return err
		}
		return c.store.MarkCompacted(ctx, c.conversation.ID, now)

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

	case ports.ChatEventUsage:
		if event.Usage == nil {
			return nil
		}
		// Overwrites rather than appends. Deliberately not reported as activity
		// either: token accounting arriving is not the agent doing work, and
		// treating it as such would keep a finished session looking busy.
		return c.store.RecordUsage(ctx, c.conversation.ID, domain.ConversationUsage{
			ContextUsed:   event.Usage.ContextUsed,
			ContextWindow: event.Usage.ContextWindow,
			InputTokens:   event.Usage.InputTokens,
			OutputTokens:  event.Usage.OutputTokens,
			CachedTokens:  event.Usage.CachedTokens,
			TotalTokens:   event.Usage.TotalTokens,
		})

	case ports.ChatEventRateLimits:
		if event.RateLimits == nil {
			return nil
		}
		return c.store.RecordRateLimits(ctx, c.conversation.ID, domain.ConversationRateLimits{
			PrimaryUsedPercent:       event.RateLimits.PrimaryUsedPercent,
			SecondaryUsedPercent:     event.RateLimits.SecondaryUsedPercent,
			PrimaryResetsInSeconds:   event.RateLimits.PrimaryResetsInSeconds,
			SecondaryResetsInSeconds: event.RateLimits.SecondaryResetsInSeconds,
			PlanLabel:                event.RateLimits.PlanLabel,
		})

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

// compactionDetail stamps the driver's reclaim figures with what kind of system
// event this row is.
//
// `system` is a general bucket, so a reader cannot tell a compaction from whatever
// else lands there next. The discriminator is set here rather than in a driver
// because the choice of kind is this projection's, not the provider's — and a
// compaction rendered as a generic notice would lose the one thing that matters
// about it: that the history above it is no longer what the agent sees.
func compactionDetail(event ports.ChatEvent) []byte {
	merged := map[string]any{}
	if len(event.Detail) > 0 {
		_ = json.Unmarshal(event.Detail, &merged)
	}
	merged["event"] = "compaction"
	encoded, err := json.Marshal(merged)
	if err != nil {
		return event.Detail
	}
	return encoded
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
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
