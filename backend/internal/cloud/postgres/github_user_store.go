package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

const defaultGitHubUserAuthAttemptTTL = 10 * time.Minute

// GitHubUserConnectionInput contains provider identity metadata and credentials
// that have already been encrypted by the control plane.
type GitHubUserConnectionInput struct {
	GitHubUserID          int64
	GitHubLogin           string
	GitHubAvatarURL       string
	AccessTokenEncrypted  []byte
	AccessTokenNonce      []byte
	AccessTokenExpiresAt  *time.Time
	RefreshTokenEncrypted []byte
	RefreshTokenNonce     []byte
	RefreshTokenExpiresAt *time.Time
	ExpectedUpdatedAt     time.Time
}

// CreateGitHubUserAuthAttempt persists one hashed OAuth state and encrypted
// PKCE verifier.
func (s *Store) CreateGitHubUserAuthAttempt(
	ctx context.Context,
	userID clouddomain.UserID,
	stateHash, verifierEncrypted, verifierNonce []byte,
	ttl time.Duration,
) (clouddomain.GitHubUserAuthAttempt, error) {
	if userID == "" || len(stateHash) != 32 || len(verifierEncrypted) == 0 || len(verifierNonce) == 0 {
		return clouddomain.GitHubUserAuthAttempt{}, ErrInvalidGitHubUserAuthAttempt
	}
	if ttl <= 0 {
		ttl = defaultGitHubUserAuthAttemptTTL
	}
	attempt, err := scanGitHubUserAuthAttempt(s.pool.QueryRow(ctx, `
		INSERT INTO ao_github_user_auth_attempts (
			user_id, state_hash, code_verifier_encrypted, code_verifier_nonce,
			expires_at
		)
		VALUES ($1, $2, $3, $4, now() + $5::interval)
		RETURNING id, user_id, state_hash, code_verifier_encrypted,
			code_verifier_nonce, expires_at, consumed_at, created_at
	`, userID, stateHash, verifierEncrypted, verifierNonce, intervalString(ttl)))
	if err != nil {
		return clouddomain.GitHubUserAuthAttempt{}, fmt.Errorf("create GitHub user auth attempt: %w", err)
	}
	return attempt, nil
}

// GetGitHubUserAuthAttempt loads one unconsumed, unexpired authorization attempt.
func (s *Store) GetGitHubUserAuthAttempt(
	ctx context.Context,
	stateHash []byte,
) (clouddomain.GitHubUserAuthAttempt, error) {
	if len(stateHash) != 32 {
		return clouddomain.GitHubUserAuthAttempt{}, ErrInvalidGitHubUserAuthAttempt
	}
	attempt, err := scanGitHubUserAuthAttempt(s.pool.QueryRow(ctx, `
		SELECT id, user_id, state_hash, code_verifier_encrypted,
			code_verifier_nonce, expires_at, consumed_at, created_at
		FROM ao_github_user_auth_attempts
		WHERE state_hash = $1
			AND consumed_at IS NULL
			AND expires_at > now()
	`, stateHash))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubUserAuthAttempt{}, ErrInvalidGitHubUserAuthAttempt
	}
	if err != nil {
		return clouddomain.GitHubUserAuthAttempt{}, fmt.Errorf("get GitHub user auth attempt: %w", err)
	}
	return attempt, nil
}

// CompleteGitHubUserAuthorization atomically consumes an OAuth attempt and
// replaces the user's encrypted GitHub credential.
func (s *Store) CompleteGitHubUserAuthorization(
	ctx context.Context,
	attemptID string,
	input GitHubUserConnectionInput,
) (clouddomain.GitHubUserConnection, error) {
	if attemptID == "" || !validGitHubUserConnectionInput(input) {
		return clouddomain.GitHubUserConnection{}, ErrInvalidGitHubUserConnection
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("begin GitHub user authorization: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var userID clouddomain.UserID
	if err := tx.QueryRow(ctx, `
		SELECT user_id
		FROM ao_github_user_auth_attempts
		WHERE id = $1
			AND consumed_at IS NULL
			AND expires_at > now()
		FOR UPDATE
	`, attemptID).Scan(&userID); errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubUserConnection{}, ErrInvalidGitHubUserAuthAttempt
	} else if err != nil {
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("lock GitHub user auth attempt: %w", err)
	}

	connection, err := scanGitHubUserConnection(tx.QueryRow(ctx, `
		INSERT INTO ao_github_user_connections (
			user_id, github_user_id, github_login, github_avatar_url,
			access_token_encrypted, access_token_nonce, access_token_expires_at,
			refresh_token_encrypted, refresh_token_nonce, refresh_token_expires_at,
			status, last_synced_at, revoked_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', now(), NULL)
		ON CONFLICT (user_id) DO UPDATE
		SET github_user_id = EXCLUDED.github_user_id,
			github_login = EXCLUDED.github_login,
			github_avatar_url = EXCLUDED.github_avatar_url,
			access_token_encrypted = EXCLUDED.access_token_encrypted,
			access_token_nonce = EXCLUDED.access_token_nonce,
			access_token_expires_at = EXCLUDED.access_token_expires_at,
			refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
			refresh_token_nonce = EXCLUDED.refresh_token_nonce,
			refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
			status = 'active',
			last_synced_at = now(),
			revoked_at = NULL,
			updated_at = now()
		RETURNING user_id, github_user_id, github_login, github_avatar_url,
			access_token_encrypted, access_token_nonce, access_token_expires_at,
			refresh_token_encrypted, refresh_token_nonce, refresh_token_expires_at,
			status, last_synced_at, revoked_at, created_at, updated_at
	`, userID, input.GitHubUserID, input.GitHubLogin, input.GitHubAvatarURL,
		input.AccessTokenEncrypted, input.AccessTokenNonce, input.AccessTokenExpiresAt,
		nullableBytes(input.RefreshTokenEncrypted), nullableBytes(input.RefreshTokenNonce),
		input.RefreshTokenExpiresAt))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return clouddomain.GitHubUserConnection{}, ErrGitHubUserConnectionConflict
		}
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("upsert GitHub user connection: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_github_user_auth_attempts
		SET consumed_at = now()
		WHERE id = $1
	`, attemptID); err != nil {
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("consume GitHub user auth attempt: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("commit GitHub user authorization: %w", err)
	}
	return connection, nil
}

// GitHubUserConnection returns the current encrypted connection for one AO user.
func (s *Store) GitHubUserConnection(
	ctx context.Context,
	userID clouddomain.UserID,
) (clouddomain.GitHubUserConnection, error) {
	connection, err := scanGitHubUserConnection(s.pool.QueryRow(ctx, `
		SELECT user_id, github_user_id, github_login, github_avatar_url,
			access_token_encrypted, access_token_nonce, access_token_expires_at,
			refresh_token_encrypted, refresh_token_nonce, refresh_token_expires_at,
			status, last_synced_at, revoked_at, created_at, updated_at
		FROM ao_github_user_connections
		WHERE user_id = $1 AND status = 'active'
	`, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubUserConnection{}, ErrGitHubUserConnectionNotFound
	}
	if err != nil {
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("get GitHub user connection: %w", err)
	}
	return connection, nil
}

// UpdateGitHubUserConnectionTokens replaces a rotated access/refresh pair.
func (s *Store) UpdateGitHubUserConnectionTokens(
	ctx context.Context,
	userID clouddomain.UserID,
	input GitHubUserConnectionInput,
) (clouddomain.GitHubUserConnection, error) {
	if userID == "" || !validGitHubUserConnectionInput(input) {
		return clouddomain.GitHubUserConnection{}, ErrInvalidGitHubUserConnection
	}
	connection, err := scanGitHubUserConnection(s.pool.QueryRow(ctx, `
		UPDATE ao_github_user_connections
		SET github_login = $2,
			github_avatar_url = $3,
			access_token_encrypted = $4,
			access_token_nonce = $5,
			access_token_expires_at = $6,
			refresh_token_encrypted = $7,
			refresh_token_nonce = $8,
			refresh_token_expires_at = $9,
			status = 'active',
			last_synced_at = now(),
			revoked_at = NULL,
			updated_at = now()
		WHERE user_id = $1
			AND github_user_id = $10
			AND updated_at = $11
		RETURNING user_id, github_user_id, github_login, github_avatar_url,
			access_token_encrypted, access_token_nonce, access_token_expires_at,
			refresh_token_encrypted, refresh_token_nonce, refresh_token_expires_at,
			status, last_synced_at, revoked_at, created_at, updated_at
	`, userID, input.GitHubLogin, input.GitHubAvatarURL,
		input.AccessTokenEncrypted, input.AccessTokenNonce, input.AccessTokenExpiresAt,
		nullableBytes(input.RefreshTokenEncrypted), nullableBytes(input.RefreshTokenNonce),
		input.RefreshTokenExpiresAt, input.GitHubUserID, input.ExpectedUpdatedAt))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubUserConnection{}, ErrGitHubUserConnectionRefreshConflict
	}
	if err != nil {
		return clouddomain.GitHubUserConnection{}, fmt.Errorf("update GitHub user tokens: %w", err)
	}
	return connection, nil
}

// DeleteGitHubUserConnection removes all durable user credentials.
func (s *Store) DeleteGitHubUserConnection(ctx context.Context, userID clouddomain.UserID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM ao_github_user_connections WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete GitHub user connection: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrGitHubUserConnectionNotFound
	}
	return nil
}

// DeleteGitHubUserConnectionByGitHubID handles provider authorization revocation.
func (s *Store) DeleteGitHubUserConnectionByGitHubID(ctx context.Context, githubUserID int64) error {
	if githubUserID <= 0 {
		return ErrInvalidGitHubUserConnection
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM ao_github_user_connections WHERE github_user_id = $1`, githubUserID)
	if err != nil {
		return fmt.Errorf("delete GitHub user connection by provider ID: %w", err)
	}
	return nil
}

func scanGitHubUserAuthAttempt(row pgx.Row) (clouddomain.GitHubUserAuthAttempt, error) {
	var attempt clouddomain.GitHubUserAuthAttempt
	err := row.Scan(
		&attempt.ID,
		&attempt.UserID,
		&attempt.StateHash,
		&attempt.CodeVerifierEncrypted,
		&attempt.CodeVerifierNonce,
		&attempt.ExpiresAt,
		&attempt.ConsumedAt,
		&attempt.CreatedAt,
	)
	return attempt, err
}

func scanGitHubUserConnection(row pgx.Row) (clouddomain.GitHubUserConnection, error) {
	var connection clouddomain.GitHubUserConnection
	err := row.Scan(
		&connection.UserID,
		&connection.GitHubUserID,
		&connection.GitHubLogin,
		&connection.GitHubAvatarURL,
		&connection.AccessTokenEncrypted,
		&connection.AccessTokenNonce,
		&connection.AccessTokenExpiresAt,
		&connection.RefreshTokenEncrypted,
		&connection.RefreshTokenNonce,
		&connection.RefreshTokenExpiresAt,
		&connection.Status,
		&connection.LastSyncedAt,
		&connection.RevokedAt,
		&connection.CreatedAt,
		&connection.UpdatedAt,
	)
	return connection, err
}

func validGitHubUserConnectionInput(input GitHubUserConnectionInput) bool {
	if input.GitHubUserID <= 0 || input.GitHubLogin == "" ||
		len(input.AccessTokenEncrypted) == 0 || len(input.AccessTokenNonce) == 0 {
		return false
	}
	hasRefreshToken := len(input.RefreshTokenEncrypted) > 0
	return hasRefreshToken == (len(input.RefreshTokenNonce) > 0) &&
		hasRefreshToken == (input.RefreshTokenExpiresAt != nil)
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

var (
	// ErrInvalidGitHubUserAuthAttempt indicates malformed or stale OAuth state.
	ErrInvalidGitHubUserAuthAttempt = errors.New("invalid GitHub user authorization attempt")
	// ErrInvalidGitHubUserConnection indicates malformed identity or credentials.
	ErrInvalidGitHubUserConnection = errors.New("invalid GitHub user connection")
	// ErrGitHubUserConnectionNotFound indicates that the AO user has not authorized GitHub.
	ErrGitHubUserConnectionNotFound = errors.New("GitHub user connection not found")
	// ErrGitHubUserConnectionConflict prevents one GitHub identity from being claimed by two AO users.
	ErrGitHubUserConnectionConflict = errors.New("GitHub user is already connected to another AO user")
	// ErrGitHubUserConnectionRefreshConflict indicates another CP instance rotated the token first.
	ErrGitHubUserConnectionRefreshConflict = errors.New("GitHub user token was refreshed concurrently")
)
