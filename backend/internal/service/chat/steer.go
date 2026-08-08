package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Steering: guidance delivered into a turn that is already running.
//
// Why this is not "interrupt, then send again". An interrupt destroys the turn —
// its reasoning, its half-applied edits, the command it has running — and the
// resend starts from nothing. A steer adds the correction to the SAME turn and
// leaves the work in place; the agent decides what to abandon. Measured against
// codex-cli 0.146.0, the steered turn kept its id and settled `completed`, having
// abandoned the command it was running on its own. So the user's guidance costs
// them nothing they had already paid for, which is the entire reason to prefer it.
//
// Optional and feature-detected, following the Models precedent: a provider that
// cannot steer gets a typed refusal a client renders as an absent control rather
// than as a failed request.

// Typed outcomes for steering. Each distinguishes advice a client can act on:
// "this agent cannot do it", "send it as a new message instead", "wait, then try
// again".
var (
	// ErrSteerUnsupported reports a driver whose provider cannot take guidance into
	// a running turn. Permanent for that harness — a client should stop offering the
	// control rather than retry.
	ErrSteerUnsupported = errors.New("chat driver cannot steer a running turn")
	// ErrTurnNotSteerable reports a turn that is running but cannot absorb guidance.
	// Codex refuses a compaction or review turn this way. Retryable once that turn
	// finishes, which is what separates it from ErrSteerUnsupported.
	ErrTurnNotSteerable = errors.New("the running turn cannot take guidance")
	// ErrSteerTextRequired refuses an empty steer. There is no keystroke concept in
	// Chat mode: an empty body is a caller bug, not a way to nudge the agent.
	ErrSteerTextRequired = errors.New("steer text is required")
)

// SteerResult is what a steer did, for a client that has to attribute it.
type SteerResult struct {
	// ProviderTurnID is the turn that absorbed the guidance. Reported rather than
	// assumed to be the one asked for: the provider names it in its own response,
	// and a client matches it against the snapshot's turns.
	ProviderTurnID string
	// ActivityID is the timeline row recording the guidance, so a client can
	// reconcile an optimistic bubble with the durable one instead of showing both.
	ActivityID string
}

// maxSteerSummaryRunes bounds the one-line label a steer lands on the timeline
// with. The full text is always kept in the activity's detail payload; this is only
// what a collapsed row shows.
const maxSteerSummaryRunes = 120

// Steer sends guidance into this session's running turn.
//
// Dispatch is decided from the persisted session mode like every other Chat
// command, so a TUI session cannot reach this path by calling the URL directly.
func (s *Service) Steer(
	ctx context.Context,
	id domain.SessionID,
	msg ports.ChatUserMessage,
) (SteerResult, error) {
	if strings.TrimSpace(msg.Text) == "" {
		return SteerResult{}, ErrSteerTextRequired
	}
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return SteerResult{}, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return SteerResult{}, err
	}
	if _, ok := controller.conv.(ports.ChatSteerer); !ok {
		return SteerResult{}, ErrSteerUnsupported
	}
	return controller.Steer(ctx, msg)
}

// Steer hands guidance to the provider for the turn currently in flight, then
// records it on that turn.
//
// The wait for acknowledgement is load-bearing, not defensive. Codex refuses a
// steer for a turn it has accepted but not yet announced — probed directly: a steer
// sent immediately after turn/start returned, carrying the id turn/start itself had
// just handed back, came back "no active turn to steer". Steering is most useful in
// exactly that window, the second after someone realizes they sent the wrong thing,
// so the same helper Interrupt uses to ride out that gap is used here.
//
// The provider is asked first and AO writes second. If the provider declines,
// nothing has been recorded — a timeline claiming guidance the agent never received
// would be worse than the refusal, because the user would stop waiting for it.
func (c *Controller) Steer(ctx context.Context, msg ports.ChatUserMessage) (SteerResult, error) {
	steerer, ok := c.conv.(ports.ChatSteerer)
	if !ok {
		return SteerResult{}, ErrSteerUnsupported
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	if c.handoffActive() {
		return SteerResult{}, ErrControllerHandoff
	}

	turn, ok := c.awaitAcknowledgedTurn(ctx)
	if !ok {
		// Nothing is in flight. Reusing the interrupt sentinel keeps one code for
		// "there is no turn" across every command that needs one; the endpoint says
		// what to do about it.
		return SteerResult{}, ErrNoActiveTurn
	}

	ref, err := steerer.Steer(ctx, turn, msg)
	if err != nil {
		switch {
		case errors.Is(err, ports.ErrChatNoSteerableTurn):
			// The turn ended, or was replaced, between AO's check and the provider's.
			// The provider is the authority on that, and losing the race is ordinary.
			return SteerResult{}, ErrNoActiveTurn
		case errors.Is(err, ports.ErrChatTurnNotSteerable):
			return SteerResult{}, fmt.Errorf("%w: %w", ErrTurnNotSteerable, err)
		}
		return SteerResult{}, classify(fmt.Errorf("steer turn %s: %w", turn, err))
	}

	landed := ref.ProviderTurnID
	if landed == "" {
		landed = turn
	}
	activityID, err := c.recordSteer(ctx, landed, msg)
	if err != nil {
		// The guidance IS with the agent; only AO's record of it failed. Reporting the
		// error rather than swallowing it, because a steer the timeline never mentions
		// is a conversation whose next answer has no visible cause.
		return SteerResult{ProviderTurnID: landed}, err
	}
	return SteerResult{ProviderTurnID: landed, ActivityID: activityID}, nil
}

// recordSteer writes the guidance onto the turn that took it.
//
// It lands as an activity, not as a message, and the reason is structural rather
// than semantic: a steer joins a turn that is already running, and AO's only durable
// write that can attach to a turn in flight is the activity row. AppendUserMessage
// opens a NEW turn — using it here would mint a second turn row that the drain loop
// would later dispatch as its own turn, sending the user's correction twice. The row
// is tagged `event: "steer"` in its detail so a client can render it as the user's
// own words rather than as a system notice, the same way compaction entries are
// identified by their discriminator instead of by the general `system` kind.
//
// The provider's own echo is not the record. It replays the guidance as a
// `userMessage` item on the turn, but the driver drops those: AO records what the
// user said when it accepts the request, and re-emitting the echo would show it
// twice.
func (c *Controller) recordSteer(
	ctx context.Context,
	providerTurnID string,
	msg ports.ChatUserMessage,
) (string, error) {
	detail := map[string]any{
		"event":  "steer",
		"text":   msg.Text,
		"origin": string(normalizeOrigin(msg.Origin)),
	}
	if msg.ClientMessageID != "" {
		detail["clientMessageId"] = msg.ClientMessageID
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return "", fmt.Errorf("encode steer detail: %w", err)
	}

	id := c.newID()
	if err := c.store.UpsertActivity(ctx, c.conversation.ID, providerTurnID,
		domain.ConversationActivity{
			ID:     id,
			Kind:   domain.ActivityKindSystem,
			Status: domain.ActivityStatusCompleted,
			// Delivered, not pending: the provider accepted it before this ran.
			Summary: steerSummary(msg.Text),
			Detail:  encoded,
			// A synthetic item key, so a client retrying with the same idempotency
			// handle updates this row instead of adding a second one. Prefixed because
			// this id is AO's, not the provider's, and the two share a column.
			ProviderItemID: steerItemID(msg.ClientMessageID),
		}, c.now()); err != nil {
		return "", fmt.Errorf("record steer on turn %s: %w", providerTurnID, err)
	}

	// No activity signal is reported. A steer only happens while a turn is running,
	// so the session is already Active; saying so again would be a signal that
	// carries no news.
	return id, nil
}

// steerItemID is the dedupe key for a recorded steer, or empty when the caller
// supplied no idempotency handle and every request is a distinct piece of guidance.
func steerItemID(clientMessageID string) string {
	if clientMessageID == "" {
		return ""
	}
	return "steer:" + clientMessageID
}

// steerSummary reduces guidance to a one-line label. The full text stays in the
// detail payload, so this only decides what a collapsed row reads like.
func steerSummary(text string) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(collapsed) <= maxSteerSummaryRunes {
		return collapsed
	}
	runes := []rune(collapsed)
	return strings.TrimRight(string(runes[:maxSteerSummaryRunes]), " ") + "…"
}
