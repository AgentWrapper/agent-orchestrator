package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// CreateLocalUser persists an email/password identity for local AO Cloud.
func (s *Store) CreateLocalUser(
	ctx context.Context,
	email, displayName, passwordHash string,
) (clouddomain.LocalUser, error) {
	var user clouddomain.LocalUser
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_local_users (email, display_name, password_hash)
		VALUES ($1, $2, $3)
		RETURNING id, email, display_name, password_hash
	`, email, displayName, passwordHash).Scan(
		&user.ID,
		&user.Email,
		&user.DisplayName,
		&user.PasswordHash,
	)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) &&
			postgresError.ConstraintName == "ao_local_users_email_lower_key" {
			return clouddomain.LocalUser{}, ErrLocalUserExists
		}
		return clouddomain.LocalUser{}, fmt.Errorf("create local user: %w", err)
	}
	if _, err := s.EnsureAccount(ctx, user.ID, displayName); err != nil {
		return clouddomain.LocalUser{}, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE ao_users
		SET email = $2,
			display_name = $3,
			updated_at = now()
		WHERE id = $1
	`, user.ID, email, displayName); err != nil {
		return clouddomain.LocalUser{}, fmt.Errorf("update cloud local user: %w", err)
	}
	return user, nil
}

// LocalUserByEmail returns the identity that owns email.
func (s *Store) LocalUserByEmail(ctx context.Context, email string) (clouddomain.LocalUser, error) {
	var user clouddomain.LocalUser
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, display_name, password_hash
		FROM ao_local_users
		WHERE lower(email) = lower($1)
	`, email).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.LocalUser{}, ErrLocalUserNotFound
	}
	if err != nil {
		return clouddomain.LocalUser{}, fmt.Errorf("get local user by email: %w", err)
	}
	return user, nil
}

type UpdateUserProfileInput struct {
	DisplayName string
}

func (s *Store) UpdateUserProfile(
	ctx context.Context,
	userID string,
	input UpdateUserProfileInput,
) (clouddomain.User, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return clouddomain.User{}, ErrInvalidUserProfile
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.User{}, fmt.Errorf("begin update user profile: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var user clouddomain.User
	err = tx.QueryRow(ctx, `
		UPDATE ao_users
		SET display_name = $2, updated_at = now()
		WHERE id = $1
		RETURNING id, auth_provider, external_user_id, email, display_name, created_at, updated_at
	`, userID, displayName).Scan(
		&user.ID,
		&user.AuthProvider,
		&user.ExternalUserID,
		&user.Email,
		&user.DisplayName,
		&user.CreatedAt,
		&user.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.User{}, ErrCloudUserNotFound
	}
	if err != nil {
		return clouddomain.User{}, fmt.Errorf("update cloud user profile: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_local_users
		SET display_name = $2
		WHERE id = $1
	`, userID, displayName); err != nil {
		return clouddomain.User{}, fmt.Errorf("update local user profile: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.User{}, fmt.Errorf("commit update user profile: %w", err)
	}
	return user, nil
}

// CreateLocalSession stores the hash of an opaque local login token.
func (s *Store) CreateLocalSession(ctx context.Context, userID string, tokenHash []byte, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ao_local_sessions (user_id, token_hash, expires_at)
		VALUES ($1, $2, $3)
	`, userID, tokenHash, expiresAt)
	if err != nil {
		return fmt.Errorf("create local session: %w", err)
	}
	return nil
}

// LocalUserBySessionTokenHash resolves an unexpired local session.
func (s *Store) LocalUserBySessionTokenHash(ctx context.Context, tokenHash []byte) (clouddomain.LocalUser, error) {
	var user clouddomain.LocalUser
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.email, u.display_name, u.password_hash
		FROM ao_local_sessions AS s
		JOIN ao_local_users AS u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now()
	`, tokenHash).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.LocalUser{}, ErrLocalSessionNotFound
	}
	if err != nil {
		return clouddomain.LocalUser{}, fmt.Errorf("get local session user: %w", err)
	}
	return user, nil
}

// DeleteLocalSession invalidates an opaque local login token.
func (s *Store) DeleteLocalSession(ctx context.Context, tokenHash []byte) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM ao_local_sessions WHERE token_hash = $1`, tokenHash); err != nil {
		return fmt.Errorf("delete local session: %w", err)
	}
	return nil
}
