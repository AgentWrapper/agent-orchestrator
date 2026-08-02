package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// Conversation persistence for Chat sessions.
//
// Two invariants live here rather than in the caller:
//
//   - Sequence allocation and the row that uses it commit together. Every write
//     that mints a position runs inside one transaction that bumps
//     conversations.latest_sequence and inserts the row, so two concurrent
//     writers cannot land on the same position.
//   - A projection and the raw provider event that produced it are written in the
//     same transaction. If the process dies between them, neither survives — so
//     the archive can never disagree with the timeline it explains.

// ErrConversationNotFound reports a lookup for a session that has none. It
// aliases the domain sentinel so a service can recognize it without importing the
// storage layer.
var ErrConversationNotFound = domain.ErrNoConversation

// ErrNoQueuedTurn reports an empty send queue. It is an ordinary outcome of
// draining, not a failure.
var ErrNoQueuedTurn = domain.ErrNoQueuedTurn

// CreateConversation opens a session-scoped conversation. Returns the existing
// one if it is already there, so a controller restart is idempotent.
func (s *Store) CreateConversation(
	ctx context.Context,
	id string,
	project domain.ProjectID,
	session domain.SessionID,
	now time.Time,
) (domain.ConversationRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if existing, err := s.qr.SelectConversationBySession(ctx, &session); err == nil {
		return conversationToDomain(existing), nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return domain.ConversationRecord{}, fmt.Errorf("select conversation for %s: %w", session, err)
	}

	if err := s.qw.InsertConversation(ctx, gen.InsertConversationParams{
		ID:        id,
		Scope:     domain.ConversationScopeSession,
		ProjectID: project,
		SessionID: &session,
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		return domain.ConversationRecord{}, fmt.Errorf("insert conversation %s: %w", id, err)
	}

	return domain.ConversationRecord{
		ID:        id,
		Scope:     domain.ConversationScopeSession,
		ProjectID: project,
		SessionID: session,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// ConversationForSession looks up a session's conversation.
func (s *Store) ConversationForSession(
	ctx context.Context,
	session domain.SessionID,
) (domain.ConversationRecord, error) {
	row, err := s.qr.SelectConversationBySession(ctx, &session)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ConversationRecord{}, ErrConversationNotFound
	}
	if err != nil {
		return domain.ConversationRecord{}, fmt.Errorf("select conversation for %s: %w", session, err)
	}
	return conversationToDomain(row), nil
}

// AppendUserMessage records an inbound message and the turn it opens.
//
// Idempotent on clientMessageID: a retried send returns the message and turn that
// already exist instead of opening a second provider turn. The caller must not
// dispatch to the provider when `created` is false.
func (s *Store) AppendUserMessage(
	ctx context.Context,
	conversationID string,
	session domain.SessionID,
	generation string,
	msg domain.ConversationMessage,
	turnID string,
	now time.Time,
) (created bool, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if msg.ClientMessageID != "" {
		existing, lookupErr := s.qr.SelectConversationMessageByClientID(ctx,
			gen.SelectConversationMessageByClientIDParams{
				ConversationID:  conversationID,
				ClientMessageID: msg.ClientMessageID,
			})
		if lookupErr == nil {
			_ = existing
			return false, nil
		}
		if !errors.Is(lookupErr, sql.ErrNoRows) {
			return false, fmt.Errorf("lookup client message %s: %w", msg.ClientMessageID, lookupErr)
		}
	}

	err = s.inTx(ctx, "append user message", func(q *gen.Queries) error {
		sequence, err := q.NextConversationSequence(ctx, gen.NextConversationSequenceParams{
			UpdatedAt: now,
			ID:        conversationID,
		})
		if err != nil {
			return fmt.Errorf("allocate sequence: %w", err)
		}

		if err := q.InsertConversationTurn(ctx, gen.InsertConversationTurnParams{
			ID:                   turnID,
			ConversationID:       conversationID,
			HandledBySessionID:   session,
			ControllerGeneration: generation,
			State:                domain.TurnStateQueued,
			RequestedAt:          now,
		}); err != nil {
			return fmt.Errorf("insert turn: %w", err)
		}

		return q.InsertConversationMessage(ctx, gen.InsertConversationMessageParams{
			ID:              msg.ID,
			ConversationID:  conversationID,
			TurnID:          sql.NullString{String: turnID, Valid: true},
			Sequence:        sequence,
			Role:            domain.MessageRoleUser,
			Origin:          msg.Origin,
			Text:            msg.Text,
			ProviderItemID:  "",
			ClientMessageID: msg.ClientMessageID,
			CreatedAt:       now,
			UpdatedAt:       now,
		})
	})
	if err != nil {
		return false, err
	}
	return true, nil
}

// BindTurnToProvider records the provider's turn id once a send is accepted and
// marks the turn running.
func (s *Store) BindTurnToProvider(ctx context.Context, turnID, providerTurnID string, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.BindConversationTurnProviderID(ctx, gen.BindConversationTurnProviderIDParams{
		ProviderTurnID: providerTurnID,
		StartedAt:      sql.NullTime{Time: now, Valid: true},
		ID:             turnID,
	}); err != nil {
		return fmt.Errorf("bind turn %s to provider turn %s: %w", turnID, providerTurnID, err)
	}
	if err := s.qw.MarkConversationTurnStarted(ctx, gen.MarkConversationTurnStartedParams{
		StartedAt: sql.NullTime{Time: now, Valid: true},
		ID:        turnID,
	}); err != nil {
		return fmt.Errorf("mark turn %s started: %w", turnID, err)
	}
	return nil
}

// SettleTurn records a turn's terminal state. An interrupted turn is not an
// error and carries no message.
func (s *Store) SettleTurn(
	ctx context.Context,
	conversationID, providerTurnID string,
	state domain.TurnState,
	errMessage string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	turn, err := s.qr.SelectConversationTurnByProviderID(ctx,
		gen.SelectConversationTurnByProviderIDParams{
			ConversationID: conversationID,
			ProviderTurnID: providerTurnID,
		})
	if errors.Is(err, sql.ErrNoRows) {
		// A turn AO never recorded, e.g. one started by a previous controller
		// before a restart. Not an error: there is nothing to settle.
		return nil
	}
	if err != nil {
		return fmt.Errorf("select turn %s: %w", providerTurnID, err)
	}

	if err := s.qw.SettleConversationTurn(ctx, gen.SettleConversationTurnParams{
		State:        state,
		ErrorMessage: errMessage,
		CompletedAt:  sql.NullTime{Time: now, Valid: true},
		ID:           turn.ID,
	}); err != nil {
		return fmt.Errorf("settle turn %s: %w", turn.ID, err)
	}
	return nil
}

// SettleOrphanedTurns marks anything a dead controller left in flight. A turn the
// controller was running is not evidence the work finished, so it settles as
// failed rather than silently completing.
func (s *Store) SettleOrphanedTurns(ctx context.Context, session domain.SessionID, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.SettleOrphanedConversationTurns(ctx,
		gen.SettleOrphanedConversationTurnsParams{
			CompletedAt:        sql.NullTime{Time: now, Valid: true},
			HandledBySessionID: session,
		}); err != nil {
		return fmt.Errorf("settle orphaned turns for %s: %w", session, err)
	}
	return nil
}

// SetConversationSettings records the provider choices for the next turn.
//
// An empty field is stored as NULL rather than as an empty string, so "the user
// cleared this" and "the user never chose" stay the same thing: fall back to the
// provider's default.
func (s *Store) SetConversationSettings(
	ctx context.Context,
	conversationID string,
	settings domain.ConversationSettings,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.UpdateConversationTurnSettings(ctx, gen.UpdateConversationTurnSettingsParams{
		Model:           nullableString(settings.Model),
		ReasoningEffort: nullableString(settings.ReasoningEffort),
		ApprovalMode:    nullableString(string(settings.ApprovalMode)),
		UpdatedAt:       now,
		ID:              conversationID,
	}); err != nil {
		return fmt.Errorf("set conversation settings for %s: %w", conversationID, err)
	}
	return nil
}

func nullableString(value string) sql.NullString {
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

// NextQueuedTurn returns the oldest message recorded while the agent was busy,
// or ErrNoQueuedTurn when the queue is empty.
//
// The queue is these rows, not a slice in a controller: a message the user typed
// is durable before it is delivered, so a daemon that dies with one queued can
// still account for it.
func (s *Store) NextQueuedTurn(ctx context.Context, conversationID string) (domain.QueuedTurn, error) {
	row, err := s.qr.SelectNextQueuedConversationTurn(ctx, conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.QueuedTurn{}, ErrNoQueuedTurn
	}
	if err != nil {
		return domain.QueuedTurn{}, fmt.Errorf("select next queued turn for %s: %w", conversationID, err)
	}
	return domain.QueuedTurn{
		TurnID:          row.ID,
		Text:            row.Text,
		ClientMessageID: row.ClientMessageID,
		Origin:          row.Origin,
	}, nil
}

// CancelQueuedTurns closes out everything queued at or before cutoff.
//
// They settle as interrupted rather than failed: nothing went wrong, the user
// stopped the agent, and a message that was never dispatched did not fail. The
// cutoff keeps a message typed after the stop out of a cancellation it predates.
func (s *Store) CancelQueuedTurns(
	ctx context.Context,
	conversationID string,
	cutoff, now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.CancelQueuedConversationTurns(ctx, gen.CancelQueuedConversationTurnsParams{
		CompletedAt:    sql.NullTime{Time: now, Valid: true},
		ConversationID: conversationID,
		RequestedAt:    cutoff,
	}); err != nil {
		return fmt.Errorf("cancel queued turns for %s: %w", conversationID, err)
	}
	return nil
}

// SettleTurnByID records a terminal state for a turn AO can name directly.
//
// Needed for a turn that never reached the provider: it has no provider turn id,
// so it cannot be found the way a running turn is. Settling those by the empty
// provider id would match an arbitrary undispatched turn instead of this one.
func (s *Store) SettleTurnByID(
	ctx context.Context,
	turnID string,
	state domain.TurnState,
	errMessage string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.SettleConversationTurn(ctx, gen.SettleConversationTurnParams{
		State:        state,
		ErrorMessage: errMessage,
		CompletedAt:  sql.NullTime{Time: now, Valid: true},
		ID:           turnID,
	}); err != nil {
		return fmt.Errorf("settle turn %s: %w", turnID, err)
	}
	return nil
}

// AppendAssistantDelta folds a streaming delta into its message, creating the
// message on first sight. The provider item id is the correlation key because AO
// does not choose the provider's message identity.
func (s *Store) AppendAssistantDelta(
	ctx context.Context,
	conversationID, providerItemID, providerTurnID, delta, messageID string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	_, err := s.qr.SelectConversationMessageByProviderItem(ctx,
		gen.SelectConversationMessageByProviderItemParams{
			ConversationID: conversationID,
			ProviderItemID: providerItemID,
		})
	switch {
	case err == nil:
		if appendErr := s.qw.AppendConversationMessageDelta(ctx,
			gen.AppendConversationMessageDeltaParams{
				Text:           delta,
				UpdatedAt:      now,
				ConversationID: conversationID,
				ProviderItemID: providerItemID,
			}); appendErr != nil {
			return fmt.Errorf("append delta to %s: %w", providerItemID, appendErr)
		}
		return nil

	case errors.Is(err, sql.ErrNoRows):
		turnID := s.turnIDFor(ctx, conversationID, providerTurnID)
		return s.inTx(ctx, "insert assistant message", func(q *gen.Queries) error {
			sequence, seqErr := q.NextConversationSequence(ctx, gen.NextConversationSequenceParams{
				UpdatedAt: now,
				ID:        conversationID,
			})
			if seqErr != nil {
				return fmt.Errorf("allocate sequence: %w", seqErr)
			}
			return q.InsertConversationMessage(ctx, gen.InsertConversationMessageParams{
				ID:             messageID,
				ConversationID: conversationID,
				TurnID:         turnID,
				Sequence:       sequence,
				Role:           domain.MessageRoleAssistant,
				Origin:         domain.MessageOriginProvider,
				Text:           delta,
				Streaming:      1,
				ProviderItemID: providerItemID,
				CreatedAt:      now,
				UpdatedAt:      now,
			})
		})

	default:
		return fmt.Errorf("lookup message %s: %w", providerItemID, err)
	}
}

// SettleAssistantMessage replaces streamed text with the provider's settled text
// and stops the streaming marker.
func (s *Store) SettleAssistantMessage(
	ctx context.Context,
	conversationID, providerItemID, providerTurnID, text, messageID string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	_, err := s.qr.SelectConversationMessageByProviderItem(ctx,
		gen.SelectConversationMessageByProviderItemParams{
			ConversationID: conversationID,
			ProviderItemID: providerItemID,
		})
	if errors.Is(err, sql.ErrNoRows) {
		// A message whose deltas AO never saw — possible if it completed inside a
		// reconnect window. Record it whole rather than dropping it.
		turnID := s.turnIDFor(ctx, conversationID, providerTurnID)
		return s.inTx(ctx, "insert assistant message", func(q *gen.Queries) error {
			sequence, seqErr := q.NextConversationSequence(ctx, gen.NextConversationSequenceParams{
				UpdatedAt: now,
				ID:        conversationID,
			})
			if seqErr != nil {
				return fmt.Errorf("allocate sequence: %w", seqErr)
			}
			return q.InsertConversationMessage(ctx, gen.InsertConversationMessageParams{
				ID:             messageID,
				ConversationID: conversationID,
				TurnID:         turnID,
				Sequence:       sequence,
				Role:           domain.MessageRoleAssistant,
				Origin:         domain.MessageOriginProvider,
				Text:           text,
				ProviderItemID: providerItemID,
				CreatedAt:      now,
				UpdatedAt:      now,
			})
		})
	}
	if err != nil {
		return fmt.Errorf("lookup message %s: %w", providerItemID, err)
	}

	if err := s.qw.SettleConversationMessage(ctx, gen.SettleConversationMessageParams{
		Text:           text,
		UpdatedAt:      now,
		ConversationID: conversationID,
		ProviderItemID: providerItemID,
	}); err != nil {
		return fmt.Errorf("settle message %s: %w", providerItemID, err)
	}
	return nil
}

// UpsertActivity records or updates a non-message timeline entry.
func (s *Store) UpsertActivity(
	ctx context.Context,
	conversationID, providerTurnID string,
	activity domain.ConversationActivity,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	detail := string(activity.Detail)

	if activity.ProviderItemID != "" {
		_, err := s.qr.SelectConversationActivityByProviderItem(ctx,
			gen.SelectConversationActivityByProviderItemParams{
				ConversationID: conversationID,
				ProviderItemID: activity.ProviderItemID,
			})
		if err == nil {
			if settleErr := s.qw.SettleConversationActivity(ctx,
				gen.SettleConversationActivityParams{
					Status:         activity.Status,
					Summary:        activity.Summary,
					DetailJson:     detail,
					UpdatedAt:      now,
					ConversationID: conversationID,
					ProviderItemID: activity.ProviderItemID,
				}); settleErr != nil {
				return fmt.Errorf("settle activity %s: %w", activity.ProviderItemID, settleErr)
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("lookup activity %s: %w", activity.ProviderItemID, err)
		}
	}

	turnID := s.turnIDFor(ctx, conversationID, providerTurnID)
	return s.inTx(ctx, "insert activity", func(q *gen.Queries) error {
		sequence, seqErr := q.NextConversationSequence(ctx, gen.NextConversationSequenceParams{
			UpdatedAt: now,
			ID:        conversationID,
		})
		if seqErr != nil {
			return fmt.Errorf("allocate sequence: %w", seqErr)
		}
		return q.InsertConversationActivity(ctx, gen.InsertConversationActivityParams{
			ID:             activity.ID,
			ConversationID: conversationID,
			TurnID:         turnID,
			Sequence:       sequence,
			Kind:           activity.Kind,
			Status:         activity.Status,
			Summary:        activity.Summary,
			DetailJson:     detail,
			RequestID:      activity.RequestID,
			ProviderItemID: activity.ProviderItemID,
			CreatedAt:      now,
			UpdatedAt:      now,
		})
	})
}

// ResolveApproval marks an approval answered. It only matches a still-pending
// row, so a card the user left on screen cannot answer a newer request.
func (s *Store) ResolveApproval(
	ctx context.Context,
	conversationID, requestID, detailJSON string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.ResolveConversationApproval(ctx, gen.ResolveConversationApprovalParams{
		DetailJson:     detailJSON,
		UpdatedAt:      now,
		ConversationID: conversationID,
		RequestID:      requestID,
	}); err != nil {
		return fmt.Errorf("resolve approval %s: %w", requestID, err)
	}
	return nil
}

// FailPendingApprovals closes out anything the user can no longer answer, because
// the provider call it was blocking is gone.
func (s *Store) FailPendingApprovals(ctx context.Context, conversationID string, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.FailPendingConversationApprovals(ctx,
		gen.FailPendingConversationApprovalsParams{
			UpdatedAt:      now,
			ConversationID: conversationID,
		}); err != nil {
		return fmt.Errorf("fail pending approvals for %s: %w", conversationID, err)
	}
	return nil
}

// RecordProviderEvent archives a raw provider event. Deduplicated on the
// provider's own event id where it has one.
func (s *Store) RecordProviderEvent(
	ctx context.Context,
	conversationID string,
	session domain.SessionID,
	providerEventID, method, payloadJSON string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err := s.qw.InsertConversationProviderEvent(ctx, gen.InsertConversationProviderEventParams{
		ConversationID:  conversationID,
		SessionID:       session,
		ProviderEventID: providerEventID,
		Method:          method,
		PayloadJson:     payloadJSON,
		ReceivedAt:      now,
	})
	if err != nil {
		// A duplicate is the dedupe index doing its job, not a failure.
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil
		}
		return fmt.Errorf("archive provider event %s: %w", method, err)
	}
	return nil
}

// ErrConversationTurnNotFound reports a turn id that is not in the conversation it
// was named against. Distinct from a rollback the provider refused: the caller
// pointed at nothing. It aliases the domain sentinel so a service can recognize it
// without importing the storage layer.
var ErrConversationTurnNotFound = domain.ErrNoConversationTurn

// TurnByID reads one turn. It returns ErrConversationTurnNotFound rather than a
// zero value, so a caller cannot mistake "no such turn" for "a turn with no
// provider id".
func (s *Store) TurnByID(ctx context.Context, turnID string) (domain.ConversationTurn, error) {
	row, err := s.qr.SelectConversationTurnByID(ctx, turnID)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ConversationTurn{}, fmt.Errorf("%w: %s", ErrConversationTurnNotFound, turnID)
	}
	if err != nil {
		return domain.ConversationTurn{}, fmt.Errorf("select turn %s: %w", turnID, err)
	}
	return turnToDomain(row), nil
}

// RollbackTurns records that a rollback discarded the named turn and everything
// after it, and returns how many turns that was.
//
// This is the AO half of an operation the provider has already performed: the agent
// has forgotten those turns, and these rows are what stop the user being shown
// prose the agent cannot recall. The three statements commit together because a
// partial result is the one state that reintroduces the disagreement the whole
// operation exists to prevent.
//
// Nothing is deleted. The turns keep their rows and their immutable sequence
// positions, marked with when they were taken back.
func (s *Store) RollbackTurns(
	ctx context.Context,
	conversationID, turnID string,
	now time.Time,
) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	turn, err := s.qr.SelectConversationTurnByID(ctx, turnID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("%w: %s", ErrConversationTurnNotFound, turnID)
	}
	if err != nil {
		return 0, fmt.Errorf("select turn %s: %w", turnID, err)
	}
	if turn.ConversationID != conversationID {
		// A turn from another conversation would otherwise anchor a rollback by
		// rowid alone and discard an arbitrary range of this one.
		return 0, fmt.Errorf("%w: %s is not in conversation %s",
			ErrConversationTurnNotFound, turnID, conversationID)
	}

	var discarded int64
	err = s.inTx(ctx, "roll back turns", func(q *gen.Queries) error {
		rows, markErr := q.MarkConversationTurnsRolledBack(ctx,
			gen.MarkConversationTurnsRolledBackParams{
				RolledBackAt:   sql.NullTime{Time: now, Valid: true},
				ConversationID: conversationID,
				ID:             turnID,
			})
		if markErr != nil {
			return fmt.Errorf("mark turns rolled back: %w", markErr)
		}
		discarded = rows

		if err := q.InterruptRolledBackQueuedTurns(ctx,
			gen.InterruptRolledBackQueuedTurnsParams{
				CompletedAt:    sql.NullTime{Time: now, Valid: true},
				ConversationID: conversationID,
			}); err != nil {
			return fmt.Errorf("interrupt rolled back queued turns: %w", err)
		}

		if err := q.FailRolledBackConversationApprovals(ctx,
			gen.FailRolledBackConversationApprovalsParams{
				UpdatedAt:        now,
				ConversationID:   conversationID,
				ConversationID_2: conversationID,
			}); err != nil {
			return fmt.Errorf("fail rolled back approvals: %w", err)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return int(discarded), nil
}

// SetProviderTitle records the title the provider reports for this conversation.
func (s *Store) SetProviderTitle(
	ctx context.Context,
	conversationID, title string,
	now time.Time,
) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.UpdateConversationProviderTitle(ctx,
		gen.UpdateConversationProviderTitleParams{
			ProviderTitle: title,
			UpdatedAt:     now,
			ID:            conversationID,
		}); err != nil {
		return fmt.Errorf("set provider title for %s: %w", conversationID, err)
	}
	return nil
}

// ApplyProviderTitle pushes a provider thread title into the session's display
// name, and reports whether it landed.
//
// applied=false is the ordinary outcome, not a failure: it means the session
// already carries a name a person chose, and that name wins. The check is the
// UPDATE's own guard rather than a read followed by a write, because a manual
// rename arriving between those two would be silently overwritten by whatever the
// provider said a moment earlier.
//
// Writing display_name is what fans the new label out to every live surface: the
// sessions_cdc_update trigger includes display_name in its guard, so the existing
// session_updated event carries it without a second notification path.
func (s *Store) ApplyProviderTitle(
	ctx context.Context,
	conversationID string,
	session domain.SessionID,
	title string,
	now time.Time,
) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	conversation, err := s.qr.SelectConversationByID(ctx, conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrConversationNotFound
	}
	if err != nil {
		return false, fmt.Errorf("select conversation %s: %w", conversationID, err)
	}

	var applied bool
	err = s.inTx(ctx, "apply provider title", func(q *gen.Queries) error {
		rows, updateErr := q.ApplyConversationTitleToSession(ctx,
			gen.ApplyConversationTitleToSessionParams{
				DisplayName: title,
				UpdatedAt:   now,
				ID:          session,
				// The witness: only a label AO itself last wrote may be replaced.
				DisplayName_2: conversation.AppliedTitle,
			})
		if updateErr != nil {
			return fmt.Errorf("apply title to session %s: %w", session, updateErr)
		}
		if rows == 0 {
			return nil
		}
		applied = true
		return q.UpdateConversationAppliedTitle(ctx, gen.UpdateConversationAppliedTitleParams{
			AppliedTitle: title,
			UpdatedAt:    now,
			ID:           conversationID,
		})
	})
	if err != nil {
		return false, err
	}
	return applied, nil
}

// ConversationSnapshot is the durable read model for one conversation.
type ConversationSnapshot struct {
	Conversation domain.ConversationRecord
	Turns        []domain.ConversationTurn
	Messages     []domain.ConversationMessage
	Activities   []domain.ConversationActivity
}

// LoadConversationSnapshot reads a whole conversation. Items come back ordered by
// sequence so the caller never has to sort.
func (s *Store) LoadConversationSnapshot(
	ctx context.Context,
	conversationID string,
) (ConversationSnapshot, error) {
	conv, err := s.qr.SelectConversationByID(ctx, conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		return ConversationSnapshot{}, ErrConversationNotFound
	}
	if err != nil {
		return ConversationSnapshot{}, fmt.Errorf("select conversation %s: %w", conversationID, err)
	}

	turnRows, err := s.qr.SelectConversationTurns(ctx, conversationID)
	if err != nil {
		return ConversationSnapshot{}, fmt.Errorf("select turns: %w", err)
	}
	// Messages and activities exclude anything attached to a rolled-back turn: the
	// agent has forgotten those, and a timeline that still showed them would be
	// describing a conversation the agent is not in.
	messageRows, err := s.qr.SelectConversationMessages(ctx,
		gen.SelectConversationMessagesParams{
			ConversationID:   conversationID,
			ConversationID_2: conversationID,
		})
	if err != nil {
		return ConversationSnapshot{}, fmt.Errorf("select messages: %w", err)
	}
	activityRows, err := s.qr.SelectConversationActivities(ctx,
		gen.SelectConversationActivitiesParams{
			ConversationID:   conversationID,
			ConversationID_2: conversationID,
		})
	if err != nil {
		return ConversationSnapshot{}, fmt.Errorf("select activities: %w", err)
	}

	snapshot := ConversationSnapshot{Conversation: conversationToDomain(conv)}
	for _, row := range turnRows {
		snapshot.Turns = append(snapshot.Turns, turnToDomain(row))
	}
	for _, row := range messageRows {
		snapshot.Messages = append(snapshot.Messages, messageToDomain(row))
	}
	for _, row := range activityRows {
		snapshot.Activities = append(snapshot.Activities, activityToDomain(row))
	}
	return snapshot, nil
}

/* ---- helpers ---------------------------------------------------------- */

// turnIDFor resolves a provider turn id to AO's turn id, or nil when the turn is
// unknown. An item with no turn still belongs in the timeline, so an unresolved
// lookup is not an error.
func (s *Store) turnIDFor(ctx context.Context, conversationID, providerTurnID string) sql.NullString {
	if providerTurnID == "" {
		return sql.NullString{}
	}
	row, err := s.qr.SelectConversationTurnByProviderID(ctx,
		gen.SelectConversationTurnByProviderIDParams{
			ConversationID: conversationID,
			ProviderTurnID: providerTurnID,
		})
	if err != nil {
		return sql.NullString{}
	}
	return sql.NullString{String: row.ID, Valid: true}
}

func conversationToDomain(row gen.Conversation) domain.ConversationRecord {
	rec := domain.ConversationRecord{
		ID:             row.ID,
		Scope:          row.Scope,
		ProjectID:      row.ProjectID,
		LatestSequence: row.LatestSequence,
		Settings: domain.ConversationSettings{
			Model:           row.Model.String,
			ReasoningEffort: row.ReasoningEffort.String,
			ApprovalMode:    domain.PermissionMode(row.ApprovalMode.String),
		},
		ProviderTitle: row.ProviderTitle,
		AppliedTitle:  row.AppliedTitle,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
	if row.SessionID != nil {
		rec.SessionID = *row.SessionID
	}
	return rec
}

func turnToDomain(row gen.ConversationTurn) domain.ConversationTurn {
	turn := domain.ConversationTurn{
		ID:                 row.ID,
		ConversationID:     row.ConversationID,
		HandledBySessionID: row.HandledBySessionID,
		ProviderTurnID:     row.ProviderTurnID,
		State:              row.State,
		ErrorMessage:       row.ErrorMessage,
		RequestedAt:        row.RequestedAt,
	}
	if row.StartedAt.Valid {
		started := row.StartedAt.Time
		turn.StartedAt = &started
	}
	if row.CompletedAt.Valid {
		completed := row.CompletedAt.Time
		turn.CompletedAt = &completed
	}
	if row.RolledBackAt.Valid {
		rolledBack := row.RolledBackAt.Time
		turn.RolledBackAt = &rolledBack
	}
	return turn
}

func messageToDomain(row gen.ConversationMessage) domain.ConversationMessage {
	msg := domain.ConversationMessage{
		ID:              row.ID,
		ConversationID:  row.ConversationID,
		Sequence:        row.Sequence,
		Revision:        row.Revision,
		Role:            row.Role,
		Origin:          row.Origin,
		Text:            row.Text,
		Streaming:       row.Streaming != 0,
		ProviderItemID:  row.ProviderItemID,
		ClientMessageID: row.ClientMessageID,
		CreatedAt:       row.CreatedAt,
		UpdatedAt:       row.UpdatedAt,
	}
	if row.TurnID.Valid {
		msg.TurnID = row.TurnID.String
	}
	return msg
}

func activityToDomain(row gen.ConversationActivity) domain.ConversationActivity {
	activity := domain.ConversationActivity{
		ID:             row.ID,
		ConversationID: row.ConversationID,
		Sequence:       row.Sequence,
		Revision:       row.Revision,
		Kind:           row.Kind,
		Status:         row.Status,
		Summary:        row.Summary,
		RequestID:      row.RequestID,
		ProviderItemID: row.ProviderItemID,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
	if row.TurnID.Valid {
		activity.TurnID = row.TurnID.String
	}
	if row.DetailJson != "" && json.Valid([]byte(row.DetailJson)) {
		activity.Detail = []byte(row.DetailJson)
	}
	return activity
}

// ProviderEventsSince reads the raw provider-event archive forward from an id.
// This is the recovery path: when a projection turns out to be wrong, these rows
// are the only account of what the provider actually said.
func (s *Store) ProviderEventsSince(
	ctx context.Context,
	conversationID string,
	afterID int64,
	limit int64,
) ([]gen.ConversationProviderEvent, error) {
	rows, err := s.qr.SelectConversationProviderEvents(ctx,
		gen.SelectConversationProviderEventsParams{
			ConversationID: conversationID,
			ID:             afterID,
			Limit:          limit,
		})
	if err != nil {
		return nil, fmt.Errorf("select provider events for %s: %w", conversationID, err)
	}
	return rows, nil
}
