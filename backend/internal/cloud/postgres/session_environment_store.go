package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// SessionEnvironment is the encrypted desired process environment for one session.
type SessionEnvironment struct {
	SessionID       clouddomain.SessionID
	OrgID           clouddomain.OrgID
	EncryptedValues []byte
	ValuesNonce     []byte
	Revision        int64
	UpdatedAt       time.Time
}

// GetSessionEnvironment returns an empty revision when no environment is configured.
func (s *Store) GetSessionEnvironment(
	ctx context.Context,
	orgID clouddomain.OrgID,
	sessionID clouddomain.SessionID,
) (SessionEnvironment, error) {
	var environment SessionEnvironment
	err := s.pool.QueryRow(ctx, `
		SELECT session_id, org_id, encrypted_values, values_nonce, revision, updated_at
		FROM ao_session_environments
		WHERE org_id = $1 AND session_id = $2
	`, orgID, sessionID).Scan(
		&environment.SessionID,
		&environment.OrgID,
		&environment.EncryptedValues,
		&environment.ValuesNonce,
		&environment.Revision,
		&environment.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if checkErr := s.pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM ao_sessions WHERE org_id = $1 AND id = $2
			)
		`, orgID, sessionID).Scan(&exists); checkErr != nil {
			return SessionEnvironment{}, fmt.Errorf("check cloud session environment owner: %w", checkErr)
		}
		if !exists {
			return SessionEnvironment{}, ErrSessionNotFound
		}
		return SessionEnvironment{SessionID: sessionID, OrgID: orgID}, nil
	}
	if err != nil {
		return SessionEnvironment{}, fmt.Errorf("load cloud session environment: %w", err)
	}
	return environment, nil
}

// UpdateSessionEnvironment replaces the encrypted environment if its revision is current.
func (s *Store) UpdateSessionEnvironment(
	ctx context.Context,
	orgID clouddomain.OrgID,
	sessionID clouddomain.SessionID,
	updatedByUserID string,
	expectedRevision int64,
	encryptedValues, valuesNonce []byte,
) (SessionEnvironment, error) {
	if expectedRevision < 0 || len(encryptedValues) == 0 || len(valuesNonce) == 0 {
		return SessionEnvironment{}, errors.New("invalid cloud session environment")
	}
	var environment SessionEnvironment
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_session_environments (
			session_id, org_id, encrypted_values, values_nonce, revision, updated_by_user_id
		)
		SELECT id, org_id, $4, $5, 1, $6
		FROM ao_sessions
		WHERE org_id = $1
			AND id = $2
			AND (
				$3 = 0
				OR EXISTS (
					SELECT 1
					FROM ao_session_environments current
					WHERE current.org_id = $1
						AND current.session_id = $2
						AND current.revision = $3
				)
			)
		ON CONFLICT (session_id) DO UPDATE
		SET encrypted_values = EXCLUDED.encrypted_values,
			values_nonce = EXCLUDED.values_nonce,
			revision = ao_session_environments.revision + 1,
			updated_by_user_id = EXCLUDED.updated_by_user_id,
			updated_at = now()
		WHERE ao_session_environments.org_id = $1
			AND ao_session_environments.revision = $3
		RETURNING session_id, org_id, encrypted_values, values_nonce, revision, updated_at
	`, orgID, sessionID, expectedRevision, encryptedValues, valuesNonce, updatedByUserID).Scan(
		&environment.SessionID,
		&environment.OrgID,
		&environment.EncryptedValues,
		&environment.ValuesNonce,
		&environment.Revision,
		&environment.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if checkErr := s.pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM ao_sessions WHERE org_id = $1 AND id = $2
			)
		`, orgID, sessionID).Scan(&exists); checkErr != nil {
			return SessionEnvironment{}, fmt.Errorf("check cloud session environment update: %w", checkErr)
		}
		if !exists {
			return SessionEnvironment{}, ErrSessionNotFound
		}
		return SessionEnvironment{}, ErrSessionEnvironmentConflict
	}
	if err != nil {
		return SessionEnvironment{}, fmt.Errorf("update cloud session environment: %w", err)
	}
	return environment, nil
}

// ErrSessionEnvironmentConflict indicates that another manager saved first.
var ErrSessionEnvironmentConflict = errors.New("cloud session environment revision conflict")
