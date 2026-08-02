package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

var activeTurnStates = []string{"queued", "provisioning", "running", "cancel_requested"}

// GetActiveTurn returns the unfinished turn for an account-owned session.
func (s *Store) GetActiveTurn(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (*clouddomain.Turn, error) {
	turn, err := scanTurn(s.pool.QueryRow(ctx, `
		SELECT id, account_id, org_id, session_id, user_message_sequence, state,
			worker_epoch, attempt_count, error_message, started_at, completed_at,
			created_at, updated_at
		FROM ao_turns
		WHERE org_id = $1
			AND session_id = $2
			AND state = ANY($3)
		LIMIT 1
	`, accountID, sessionID, activeTurnStates))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load active cloud turn: %w", err)
	}
	return &turn, nil
}

// GetLatestTurn returns the newest turn for an account-owned session,
// including terminal turns.
func (s *Store) GetLatestTurn(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (*clouddomain.Turn, error) {
	turn, err := scanTurn(s.pool.QueryRow(ctx, `
		SELECT id, account_id, org_id, session_id, user_message_sequence, state,
			worker_epoch, attempt_count, error_message, started_at, completed_at,
			created_at, updated_at
		FROM ao_turns
		WHERE org_id = $1
			AND session_id = $2
		ORDER BY created_at DESC
		LIMIT 1
	`, accountID, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load latest cloud turn: %w", err)
	}
	return &turn, nil
}

// TransitionActiveTurn moves the current turn forward without reviving a
// terminal turn or regressing a running turn back to provisioning.
func (s *Store) TransitionActiveTurn(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	state, errorMessage string,
) (*clouddomain.Turn, error) {
	turn, err := scanTurn(s.pool.QueryRow(ctx, `
		UPDATE ao_turns
		SET state = $3,
			error_message = CASE WHEN $3 = 'failed' THEN $4 ELSE error_message END,
			started_at = CASE
				WHEN $3 = 'running' THEN COALESCE(started_at, now())
				ELSE started_at
			END,
			completed_at = CASE
				WHEN $3 IN ('completed', 'failed') THEN COALESCE(completed_at, now())
				ELSE completed_at
			END,
			updated_at = now()
		WHERE org_id = $1
			AND session_id = $2
			AND state = ANY($5)
			AND (
				$3 <> 'provisioning'
				OR state = 'queued'
			)
			AND (
				$3 <> 'running'
				OR state IN ('queued', 'provisioning', 'running')
			)
		RETURNING id, account_id, org_id, session_id, user_message_sequence, state,
			worker_epoch, attempt_count, error_message, started_at, completed_at,
			created_at, updated_at
	`, accountID, sessionID, state, errorMessage, activeTurnStates))
	if errors.Is(err, pgx.ErrNoRows) {
		return s.GetActiveTurn(ctx, accountID, sessionID)
	}
	if err != nil {
		return nil, fmt.Errorf("transition active cloud turn: %w", err)
	}
	return &turn, nil
}

// ClaimActiveTurn records the worker epoch that accepted a prompt. Repeating
// the claim from the same worker is idempotent.
func (s *Store) ClaimActiveTurn(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	userMessageSequence, workerEpoch int64,
) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ao_turns
		SET worker_epoch = $4,
			attempt_count = CASE
				WHEN worker_epoch = $4 THEN attempt_count
				ELSE attempt_count + 1
			END,
			updated_at = now()
		WHERE org_id = $1
			AND session_id = $2
			AND user_message_sequence = $3
			AND state = ANY($5)
	`, accountID, sessionID, userMessageSequence, workerEpoch, activeTurnStates)
	if err != nil {
		return fmt.Errorf("claim active cloud turn: %w", err)
	}
	return nil
}

// PrepareActiveTurnForWorker resets a turn claimed by a replaced worker and
// returns the prompt sequence that the new worker must replay.
func (s *Store) PrepareActiveTurnForWorker(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	workerEpoch int64,
) (int64, error) {
	var sequence int64
	err := s.pool.QueryRow(ctx, `
		UPDATE ao_turns
		SET state = 'provisioning',
			worker_epoch = 0,
			started_at = NULL,
			updated_at = now()
		WHERE org_id = $1
			AND session_id = $2
			AND state IN ('queued', 'provisioning', 'running')
			AND worker_epoch > 0
			AND worker_epoch <> $3
		RETURNING user_message_sequence
	`, accountID, sessionID, workerEpoch).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("prepare active turn for replacement worker: %w", err)
	}
	return sequence, nil
}

func scanTurn(row rowScanner) (clouddomain.Turn, error) {
	var turn clouddomain.Turn
	err := row.Scan(
		&turn.ID,
		&turn.AccountID,
		&turn.OrgID,
		&turn.SessionID,
		&turn.UserMessageSequence,
		&turn.State,
		&turn.WorkerEpoch,
		&turn.AttemptCount,
		&turn.ErrorMessage,
		&turn.StartedAt,
		&turn.CompletedAt,
		&turn.CreatedAt,
		&turn.UpdatedAt,
	)
	return turn, err
}
