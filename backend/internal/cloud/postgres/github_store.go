package postgres

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

const defaultGitHubInstallAttemptTTL = 10 * time.Minute

// GitHubInstallationInput contains GitHub-owned installation metadata.
type GitHubInstallationInput struct {
	InstallationID      int64
	AccountID           int64
	AccountLogin        string
	AccountType         string
	Status              string
	RepositorySelection string
	Permissions         json.RawMessage
	Events              []string
}

// GitHubPendingInstallationInput is the provider-verified snapshot recorded by
// the public GitHub setup callback before an AO administrator confirms it.
type GitHubPendingInstallationInput struct {
	InstallationID      int64
	AccountID           int64
	AccountLogin        string
	AccountType         string
	RepositorySelection string
	RepositoryCount     int
}

// GitHubInstallationConfirmation contains canonical provider data already
// fetched and validated by the HTTP layer.
type GitHubInstallationConfirmation struct {
	Installation GitHubInstallationInput
	Repositories []clouddomain.GitHubRepository
}

// GitHubInstallationStatusUpdate records a lifecycle event for an installation.
type GitHubInstallationStatusUpdate struct {
	Status     string
	OccurredAt time.Time
}

// GitHubWebhookDeliveryInput contains the verified, unprocessed webhook body
// and the routing metadata extracted from it.
type GitHubWebhookDeliveryInput struct {
	DeliveryID     string
	Event          string
	Action         string
	InstallationID *int64
	RepositoryID   *int64
	Payload        []byte
}

// CreateGitHubInstallAttempt creates an org-scoped, single-use setup state.
// Only the hash is stored; state must be sent to GitHub and cannot be recovered.
func (s *Store) CreateGitHubInstallAttempt(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	metadata json.RawMessage,
	ttl time.Duration,
) (string, clouddomain.GitHubInstallAttempt, error) {
	if orgID == "" || userID == "" {
		return "", clouddomain.GitHubInstallAttempt{}, ErrInvalidGitHubInstallAttempt
	}
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	if !json.Valid(metadata) {
		return "", clouddomain.GitHubInstallAttempt{}, ErrInvalidGitHubInstallAttempt
	}
	if ttl <= 0 {
		ttl = defaultGitHubInstallAttemptTTL
	}
	state, hash, err := newGitHubInstallState(rand.Reader)
	if err != nil {
		return "", clouddomain.GitHubInstallAttempt{}, err
	}
	attempt, err := scanGitHubInstallAttempt(s.pool.QueryRow(ctx, `
		INSERT INTO ao_github_install_attempts (
			org_id, initiating_user_id, state_hash, metadata, expires_at
		)
		VALUES ($1, $2, $3, $4, now() + $5::interval)
		RETURNING id, org_id, initiating_user_id, state_hash, metadata,
			pending_github_installation_id, pending_github_account_id,
			pending_account_login, pending_account_type, pending_repository_selection,
			pending_repository_count, pending_recorded_at, expires_at, consumed_at,
			created_at
	`, orgID, userID, hash, metadata, intervalString(ttl)))
	if err != nil {
		return "", clouddomain.GitHubInstallAttempt{}, fmt.Errorf("create GitHub install attempt: %w", err)
	}
	return state, attempt, nil
}

// RecordPendingGitHubInstallation atomically records the first provider-
// verified installation returned for a still-valid setup attempt. Repeating
// the callback for that installation is idempotent; another installation
// cannot replace it.
func (s *Store) RecordPendingGitHubInstallation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	state string,
	input GitHubPendingInstallationInput,
) (clouddomain.GitHubInstallAttempt, error) {
	if err := normalizeGitHubPendingInstallationInput(&input); err != nil {
		return clouddomain.GitHubInstallAttempt{}, err
	}
	hash := hashGitHubInstallState(state)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.GitHubInstallAttempt{}, fmt.Errorf("begin pending GitHub installation update: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	attempt, err := scanGitHubInstallAttempt(tx.QueryRow(ctx, `
		SELECT id, org_id, initiating_user_id, state_hash, metadata,
			pending_github_installation_id, pending_github_account_id,
			pending_account_login, pending_account_type, pending_repository_selection,
			pending_repository_count, pending_recorded_at, expires_at, consumed_at,
			created_at
		FROM ao_github_install_attempts
		WHERE org_id = $1
			AND initiating_user_id = $2
			AND state_hash = $3
			AND consumed_at IS NULL
			AND expires_at > now()
		FOR UPDATE
	`, orgID, userID, hash))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubInstallAttempt{}, ErrInvalidGitHubInstallAttempt
	}
	if err != nil {
		return clouddomain.GitHubInstallAttempt{}, fmt.Errorf("load GitHub install attempt for callback: %w", err)
	}
	if attempt.PendingGitHubInstallationID != nil {
		if *attempt.PendingGitHubInstallationID != input.InstallationID {
			return clouddomain.GitHubInstallAttempt{}, ErrGitHubInstallAttemptConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return clouddomain.GitHubInstallAttempt{}, fmt.Errorf("commit idempotent GitHub install callback: %w", err)
		}
		return attempt, nil
	}

	attempt, err = scanGitHubInstallAttempt(tx.QueryRow(ctx, `
		UPDATE ao_github_install_attempts
		SET pending_github_installation_id = $2,
			pending_github_account_id = $3,
			pending_account_login = $4,
			pending_account_type = $5,
			pending_repository_selection = $6,
			pending_repository_count = $7,
			pending_recorded_at = now()
		WHERE id = $1
		RETURNING id, org_id, initiating_user_id, state_hash, metadata,
			pending_github_installation_id, pending_github_account_id,
			pending_account_login, pending_account_type, pending_repository_selection,
			pending_repository_count, pending_recorded_at, expires_at, consumed_at,
			created_at
	`, attempt.ID, input.InstallationID, input.AccountID, input.AccountLogin,
		input.AccountType, input.RepositorySelection, input.RepositoryCount))
	if err != nil {
		return clouddomain.GitHubInstallAttempt{}, fmt.Errorf("record pending GitHub installation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.GitHubInstallAttempt{}, fmt.Errorf("commit pending GitHub installation: %w", err)
	}
	return attempt, nil
}

// GetPendingGitHubInstallation loads the unconsumed provider-verified setup
// snapshot for human review.
func (s *Store) GetPendingGitHubInstallation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	state string,
) (clouddomain.GitHubInstallAttempt, error) {
	attempt, err := scanGitHubInstallAttempt(s.pool.QueryRow(ctx, `
		SELECT id, org_id, initiating_user_id, state_hash, metadata,
			pending_github_installation_id, pending_github_account_id,
			pending_account_login, pending_account_type, pending_repository_selection,
			pending_repository_count, pending_recorded_at, expires_at, consumed_at,
			created_at
		FROM ao_github_install_attempts
		WHERE org_id = $1
			AND initiating_user_id = $2
			AND state_hash = $3
			AND pending_github_installation_id IS NOT NULL
			AND consumed_at IS NULL
			AND expires_at > now()
	`, orgID, userID, hashGitHubInstallState(state)))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubInstallAttempt{}, ErrInvalidGitHubInstallAttempt
	}
	if err != nil {
		return clouddomain.GitHubInstallAttempt{}, fmt.Errorf("load pending GitHub installation: %w", err)
	}
	return attempt, nil
}

// ConfirmGitHubInstallation atomically binds a provider-verified installation,
// synchronizes its active repository grants, and consumes the matching setup
// attempt. The attempt remains reusable when any database operation fails.
func (s *Store) ConfirmGitHubInstallation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	state string,
	confirmation GitHubInstallationConfirmation,
) ([]clouddomain.GitHubRepositoryGrant, error) {
	if err := normalizeGitHubInstallationInput(&confirmation.Installation); err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin GitHub installation confirmation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	attempt, err := scanGitHubInstallAttempt(tx.QueryRow(ctx, `
		SELECT id, org_id, initiating_user_id, state_hash, metadata,
			pending_github_installation_id, pending_github_account_id,
			pending_account_login, pending_account_type, pending_repository_selection,
			pending_repository_count, pending_recorded_at, expires_at, consumed_at,
			created_at
		FROM ao_github_install_attempts
		WHERE org_id = $1
			AND initiating_user_id = $2
			AND state_hash = $3
			AND pending_github_installation_id = $4
			AND consumed_at IS NULL
			AND expires_at > now()
		FOR UPDATE
	`, orgID, userID, hashGitHubInstallState(state), confirmation.Installation.InstallationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidGitHubInstallAttempt
	}
	if err != nil {
		return nil, fmt.Errorf("lock GitHub install attempt for confirmation: %w", err)
	}
	if !matchesPendingGitHubConfirmation(attempt, confirmation) {
		return nil, ErrInvalidGitHubInstallAttempt
	}

	if _, err := bindGitHubInstallation(
		ctx,
		tx,
		orgID,
		userID,
		confirmation.Installation,
	); err != nil {
		return nil, err
	}

	grants := make([]clouddomain.GitHubRepositoryGrant, 0)
	if confirmation.Installation.Status == "active" {
		grants, err = fullSyncGitHubRepositoriesTx(
			ctx,
			tx,
			orgID,
			confirmation.Installation.InstallationID,
			confirmation.Repositories,
		)
		if err != nil {
			return nil, err
		}
	}

	tag, err := tx.Exec(ctx, `
		UPDATE ao_github_install_attempts
		SET consumed_at = now()
		WHERE id = $1 AND consumed_at IS NULL
	`, attempt.ID)
	if err != nil {
		return nil, fmt.Errorf("consume confirmed GitHub install attempt: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrInvalidGitHubInstallAttempt
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit GitHub installation confirmation: %w", err)
	}
	return grants, nil
}

// BindGitHubInstallation binds a numeric GitHub installation exclusively to
// one AO organization and updates its GitHub-owned metadata.
func (s *Store) BindGitHubInstallation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	input GitHubInstallationInput,
) (clouddomain.GitHubInstallation, error) {
	if err := normalizeGitHubInstallationInput(&input); err != nil {
		return clouddomain.GitHubInstallation{}, err
	}
	return bindGitHubInstallation(ctx, s.pool, orgID, userID, input)
}

func bindGitHubInstallation(
	ctx context.Context,
	querier githubRepositoryQuerier,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	input GitHubInstallationInput,
) (clouddomain.GitHubInstallation, error) {
	installation, err := scanGitHubInstallation(querier.QueryRow(ctx, `
		INSERT INTO ao_github_installations (
			org_id, github_installation_id, github_account_id, account_login,
			account_type, status, repository_selection, permissions, events,
			installed_by_user_id, suspended_at, disconnected_at, deleted_at
		)
		VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
			CASE WHEN $6 = 'suspended' THEN now() END,
			CASE WHEN $6 = 'disconnected' THEN now() END,
			CASE WHEN $6 = 'deleted' THEN now() END
		)
		ON CONFLICT (github_installation_id) DO UPDATE
		SET github_account_id = EXCLUDED.github_account_id,
			account_login = EXCLUDED.account_login,
			account_type = EXCLUDED.account_type,
			status = EXCLUDED.status,
			repository_selection = EXCLUDED.repository_selection,
			permissions = EXCLUDED.permissions,
			events = EXCLUDED.events,
			installed_by_user_id = EXCLUDED.installed_by_user_id,
			suspended_at = EXCLUDED.suspended_at,
			disconnected_at = EXCLUDED.disconnected_at,
			deleted_at = EXCLUDED.deleted_at,
			updated_at = now()
		WHERE ao_github_installations.org_id = EXCLUDED.org_id
		RETURNING id, org_id, github_installation_id, github_account_id,
			account_login, account_type, status, repository_selection, permissions,
			events, installed_by_user_id, suspended_at, disconnected_at, deleted_at,
			created_at, updated_at
	`, orgID, input.InstallationID, input.AccountID, input.AccountLogin,
		input.AccountType, input.Status, input.RepositorySelection, input.Permissions,
		input.Events, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubInstallation{}, ErrGitHubInstallationConflict
	}
	if err != nil {
		return clouddomain.GitHubInstallation{}, fmt.Errorf("bind GitHub installation: %w", err)
	}
	return installation, nil
}

// ListGitHubInstallations returns all current and historical installation
// bindings for an organization.
func (s *Store) ListGitHubInstallations(
	ctx context.Context,
	orgID clouddomain.OrgID,
) ([]clouddomain.GitHubInstallation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, github_installation_id, github_account_id,
			account_login, account_type, status, repository_selection, permissions,
			events, installed_by_user_id, suspended_at, disconnected_at, deleted_at,
			created_at, updated_at
		FROM ao_github_installations
		WHERE org_id = $1
		ORDER BY created_at, github_installation_id
	`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list GitHub installations: %w", err)
	}
	defer rows.Close()
	out := make([]clouddomain.GitHubInstallation, 0)
	for rows.Next() {
		installation, scanErr := scanGitHubInstallation(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan GitHub installation: %w", scanErr)
		}
		out = append(out, installation)
	}
	return out, rows.Err()
}

// FindGitHubInstallationByGitHubID resolves webhook installation metadata to
// its exclusive AO organization.
func (s *Store) FindGitHubInstallationByGitHubID(
	ctx context.Context,
	githubInstallationID int64,
) (clouddomain.GitHubInstallation, error) {
	installation, err := scanGitHubInstallation(s.pool.QueryRow(ctx, `
		SELECT id, org_id, github_installation_id, github_account_id,
			account_login, account_type, status, repository_selection, permissions,
			events, installed_by_user_id, suspended_at, disconnected_at, deleted_at,
			created_at, updated_at
		FROM ao_github_installations
		WHERE github_installation_id = $1
	`, githubInstallationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubInstallation{}, ErrGitHubInstallationNotFound
	}
	if err != nil {
		return clouddomain.GitHubInstallation{}, fmt.Errorf("find GitHub installation: %w", err)
	}
	return installation, nil
}

// DisconnectGitHubInstallation disconnects an installation and revokes all of
// its active repository grants while preserving their history.
func (s *Store) DisconnectGitHubInstallation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	githubInstallationID int64,
) error {
	_, err := s.UpdateGitHubInstallationStatus(ctx, orgID, githubInstallationID, GitHubInstallationStatusUpdate{
		Status: "disconnected",
	})
	return err
}

// UpdateGitHubInstallationStatus applies a GitHub installation lifecycle event.
func (s *Store) UpdateGitHubInstallationStatus(
	ctx context.Context,
	orgID clouddomain.OrgID,
	githubInstallationID int64,
	update GitHubInstallationStatusUpdate,
) (clouddomain.GitHubInstallation, error) {
	if !validGitHubInstallationStatus(update.Status) || githubInstallationID <= 0 {
		return clouddomain.GitHubInstallation{}, ErrInvalidGitHubInstallation
	}
	if update.OccurredAt.IsZero() {
		update.OccurredAt = time.Now().UTC()
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.GitHubInstallation{}, fmt.Errorf("begin GitHub installation status update: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	installation, err := scanGitHubInstallation(tx.QueryRow(ctx, `
		UPDATE ao_github_installations
		SET status = $3,
			suspended_at = CASE
				WHEN $3 = 'suspended' THEN $4
				WHEN $3 = 'active' THEN NULL
				ELSE suspended_at
			END,
			disconnected_at = CASE
				WHEN $3 = 'disconnected' THEN $4
				WHEN $3 = 'active' THEN NULL
				ELSE disconnected_at
			END,
			deleted_at = CASE
				WHEN $3 = 'deleted' THEN $4
				WHEN $3 = 'active' THEN NULL
				ELSE deleted_at
			END,
			updated_at = now()
		WHERE org_id = $1 AND github_installation_id = $2
		RETURNING id, org_id, github_installation_id, github_account_id,
			account_login, account_type, status, repository_selection, permissions,
			events, installed_by_user_id, suspended_at, disconnected_at, deleted_at,
			created_at, updated_at
	`, orgID, githubInstallationID, update.Status, update.OccurredAt))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubInstallation{}, ErrGitHubInstallationNotFound
	}
	if err != nil {
		return clouddomain.GitHubInstallation{}, fmt.Errorf("update GitHub installation status: %w", err)
	}
	if update.Status == "disconnected" || update.Status == "deleted" {
		if _, err := tx.Exec(ctx, `
			UPDATE ao_github_repository_grants
			SET revoked_at = COALESCE(revoked_at, $3),
				revoke_reason = CASE
					WHEN revoke_reason = '' THEN 'installation_' || $4
					ELSE revoke_reason
				END,
				last_synced_at = now()
			WHERE org_id = $1 AND installation_id = $2 AND revoked_at IS NULL
		`, orgID, installation.ID, update.OccurredAt, update.Status); err != nil {
			return clouddomain.GitHubInstallation{}, fmt.Errorf("revoke disconnected GitHub grants: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.GitHubInstallation{}, fmt.Errorf("commit GitHub installation status update: %w", err)
	}
	return installation, nil
}

// UpsertGitHubRepository updates metadata for an immutable numeric repository
// identity.
func (s *Store) UpsertGitHubRepository(
	ctx context.Context,
	repository clouddomain.GitHubRepository,
) (clouddomain.GitHubRepository, error) {
	return upsertGitHubRepository(ctx, s.pool, repository)
}

// FullSyncGitHubRepositories replaces the active repository set observed for
// one installation. Revocations are timestamps, never deletes.
func (s *Store) FullSyncGitHubRepositories(
	ctx context.Context,
	orgID clouddomain.OrgID,
	githubInstallationID int64,
	repositories []clouddomain.GitHubRepository,
) ([]clouddomain.GitHubRepositoryGrant, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, fmt.Errorf("begin GitHub repository sync: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	grants, err := fullSyncGitHubRepositoriesTx(
		ctx,
		tx,
		orgID,
		githubInstallationID,
		repositories,
	)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit GitHub repository sync: %w", err)
	}
	return grants, nil
}

func fullSyncGitHubRepositoriesTx(
	ctx context.Context,
	tx pgx.Tx,
	orgID clouddomain.OrgID,
	githubInstallationID int64,
	repositories []clouddomain.GitHubRepository,
) ([]clouddomain.GitHubRepositoryGrant, error) {
	var installationID, selection string
	err := tx.QueryRow(ctx, `
		SELECT id, repository_selection
		FROM ao_github_installations
		WHERE org_id = $1 AND github_installation_id = $2 AND status = 'active'
		FOR UPDATE
	`, orgID, githubInstallationID).Scan(&installationID, &selection)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrGitHubInstallationNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load GitHub installation for repository sync: %w", err)
	}
	repositoryIDs := make([]int64, 0, len(repositories))
	seen := make(map[int64]struct{}, len(repositories))
	for _, repository := range repositories {
		if _, duplicate := seen[repository.ID]; duplicate {
			continue
		}
		seen[repository.ID] = struct{}{}
		if _, err := upsertGitHubRepository(ctx, tx, repository); err != nil {
			return nil, err
		}
		repositoryIDs = append(repositoryIDs, repository.ID)
		if _, err := tx.Exec(ctx, `
			UPDATE ao_github_repository_grants
			SET revoked_at = now(),
				revoke_reason = 'installation_changed',
				last_synced_at = now()
			WHERE org_id = $1
				AND github_repository_id = $2
				AND installation_id <> $3
				AND revoked_at IS NULL
		`, orgID, repository.ID, installationID); err != nil {
			return nil, fmt.Errorf("revoke superseded GitHub repository grant: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ao_github_repository_grants (
				org_id, installation_id, github_repository_id, repository_selection
			)
			SELECT $1, $2, $3, $4
			WHERE NOT EXISTS (
				SELECT 1
				FROM ao_github_repository_grants
				WHERE org_id = $1
					AND github_repository_id = $3
					AND revoked_at IS NULL
			)
		`, orgID, installationID, repository.ID, selection); err != nil {
			return nil, fmt.Errorf("create GitHub repository grant: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ao_github_repository_grants
			SET repository_selection = $4, last_synced_at = now()
			WHERE org_id = $1
				AND installation_id = $2
				AND github_repository_id = $3
				AND revoked_at IS NULL
		`, orgID, installationID, repository.ID, selection); err != nil {
			return nil, fmt.Errorf("refresh GitHub repository grant: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_github_repository_grants
		SET revoked_at = now(),
			revoke_reason = 'repository_sync',
			last_synced_at = now()
		WHERE org_id = $1
			AND installation_id = $2
			AND revoked_at IS NULL
			AND NOT (github_repository_id = ANY($3::bigint[]))
	`, orgID, installationID, repositoryIDs); err != nil {
		return nil, fmt.Errorf("revoke removed GitHub repository grants: %w", err)
	}
	rows, err := tx.Query(ctx, `
		SELECT repository_grant.id, repository_grant.org_id, repository_grant.installation_id,
			installation.github_installation_id, repository_grant.github_repository_id,
			repository_grant.repository_selection, repository_grant.granted_at, repository_grant.last_synced_at,
			repository_grant.revoked_at, repository_grant.revoke_reason, repository_grant.metadata
		FROM ao_github_repository_grants repository_grant
		JOIN ao_github_installations installation
			ON installation.org_id = repository_grant.org_id
			AND installation.id = repository_grant.installation_id
		WHERE repository_grant.org_id = $1
			AND repository_grant.installation_id = $2
			AND repository_grant.revoked_at IS NULL
		ORDER BY repository_grant.github_repository_id
	`, orgID, installationID)
	if err != nil {
		return nil, fmt.Errorf("list synced GitHub repository grants: %w", err)
	}
	grants := make([]clouddomain.GitHubRepositoryGrant, 0, len(repositoryIDs))
	for rows.Next() {
		grant, scanErr := scanGitHubRepositoryGrant(rows)
		if scanErr != nil {
			rows.Close()
			return nil, fmt.Errorf("scan synced GitHub repository grant: %w", scanErr)
		}
		grants = append(grants, grant)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("scan synced GitHub repository grants: %w", err)
	}
	rows.Close()
	return grants, nil
}

// RevokeGitHubRepositoryGrant revokes an organization's current grant.
func (s *Store) RevokeGitHubRepositoryGrant(
	ctx context.Context,
	orgID clouddomain.OrgID,
	githubRepositoryID int64,
	reason string,
) error {
	if strings.TrimSpace(reason) == "" {
		reason = "manual"
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_github_repository_grants
		SET revoked_at = now(), revoke_reason = $3, last_synced_at = now()
		WHERE org_id = $1 AND github_repository_id = $2 AND revoked_at IS NULL
	`, orgID, githubRepositoryID, reason)
	if err != nil {
		return fmt.Errorf("revoke GitHub repository grant: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrGitHubRepositoryGrantNotFound
	}
	return nil
}

// FindActiveGitHubRepositoryGrant returns an active grant only while its
// installation is active.
func (s *Store) FindActiveGitHubRepositoryGrant(
	ctx context.Context,
	orgID clouddomain.OrgID,
	githubRepositoryID int64,
) (clouddomain.GitHubRepositoryGrant, error) {
	grant, err := scanGitHubRepositoryGrant(s.pool.QueryRow(ctx, `
		SELECT repository_grant.id, repository_grant.org_id, repository_grant.installation_id,
			installation.github_installation_id, repository_grant.github_repository_id,
			repository_grant.repository_selection, repository_grant.granted_at, repository_grant.last_synced_at,
			repository_grant.revoked_at, repository_grant.revoke_reason, repository_grant.metadata
		FROM ao_github_repository_grants repository_grant
		JOIN ao_github_installations installation
			ON installation.org_id = repository_grant.org_id
			AND installation.id = repository_grant.installation_id
		WHERE repository_grant.org_id = $1
			AND repository_grant.github_repository_id = $2
			AND repository_grant.revoked_at IS NULL
			AND installation.status = 'active'
	`, orgID, githubRepositoryID))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubRepositoryGrant{}, ErrGitHubRepositoryGrantNotFound
	}
	if err != nil {
		return clouddomain.GitHubRepositoryGrant{}, fmt.Errorf("find active GitHub repository grant: %w", err)
	}
	return grant, nil
}

// ListActiveGitHubRepositories returns repositories currently authorized for
// an organization together with the installation grant that authorizes each.
func (s *Store) ListActiveGitHubRepositories(
	ctx context.Context,
	orgID clouddomain.OrgID,
) ([]clouddomain.GitHubGrantedRepository, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT repository.github_repository_id,
			repository.github_owner_account_id, repository.name,
			repository.full_name, repository.html_url, repository.clone_url,
			repository.ssh_url, repository.default_branch,
			repository.visibility, repository.is_private,
			repository.is_archived, repository.is_disabled,
			repository.metadata, repository.github_updated_at,
			repository.first_seen_at, repository.last_synced_at,
			repository_grant.id, repository_grant.org_id, repository_grant.installation_id,
			installation.github_installation_id, repository_grant.github_repository_id,
			repository_grant.repository_selection, repository_grant.granted_at, repository_grant.last_synced_at,
			repository_grant.revoked_at, repository_grant.revoke_reason, repository_grant.metadata
		FROM ao_github_repository_grants repository_grant
		JOIN ao_github_installations installation
			ON installation.org_id = repository_grant.org_id
			AND installation.id = repository_grant.installation_id
		JOIN ao_github_repositories repository
			ON repository.github_repository_id = repository_grant.github_repository_id
		WHERE repository_grant.org_id = $1
			AND repository_grant.revoked_at IS NULL
			AND installation.status = 'active'
		ORDER BY lower(repository.full_name), repository.github_repository_id
	`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list active GitHub repositories: %w", err)
	}
	defer rows.Close()
	result := make([]clouddomain.GitHubGrantedRepository, 0)
	for rows.Next() {
		item, scanErr := scanGitHubGrantedRepository(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan active GitHub repository: %w", scanErr)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list active GitHub repositories: %w", err)
	}
	return result, nil
}

// InsertGitHubWebhookDelivery inserts a webhook inbox item. A byte-identical
// replay is deduplicated; reuse of a delivery ID for different content fails.
func (s *Store) InsertGitHubWebhookDelivery(
	ctx context.Context,
	input GitHubWebhookDeliveryInput,
) (clouddomain.GitHubWebhookDelivery, bool, error) {
	if err := validateGitHubWebhookDeliveryInput(input); err != nil {
		return clouddomain.GitHubWebhookDelivery{}, false, err
	}
	hash := hashGitHubWebhookPayload(input.Payload)
	delivery, err := scanGitHubWebhookDelivery(s.pool.QueryRow(ctx, `
		INSERT INTO ao_github_webhook_deliveries (
			github_delivery_id, event, action, github_installation_id,
			github_repository_id, payload, payload_hash
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (github_delivery_id) DO NOTHING
		RETURNING github_delivery_id, event, action, github_installation_id,
			github_repository_id, payload, payload_hash, status, attempt_count,
			received_at, processing_started_at, last_attempt_at, processed_at,
			next_attempt_at, last_error, last_error_at, updated_at
	`, input.DeliveryID, input.Event, input.Action, input.InstallationID,
		input.RepositoryID, input.Payload, hash))
	if err == nil {
		return delivery, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubWebhookDelivery{}, false, fmt.Errorf("insert GitHub webhook delivery: %w", err)
	}
	existing, err := scanGitHubWebhookDelivery(s.pool.QueryRow(ctx, `
		SELECT github_delivery_id, event, action, github_installation_id,
			github_repository_id, payload, payload_hash, status, attempt_count,
			received_at, processing_started_at, last_attempt_at, processed_at,
			next_attempt_at, last_error, last_error_at, updated_at
		FROM ao_github_webhook_deliveries
		WHERE github_delivery_id = $1
	`, input.DeliveryID))
	if err != nil {
		return clouddomain.GitHubWebhookDelivery{}, false, fmt.Errorf("load duplicate GitHub webhook delivery: %w", err)
	}
	if !sameGitHubWebhookDelivery(existing, input, hash) {
		return clouddomain.GitHubWebhookDelivery{}, false, ErrGitHubWebhookReplayConflict
	}
	return existing, false, nil
}

// ClaimNextGitHubWebhookDelivery atomically claims the oldest ready inbox item.
func (s *Store) ClaimNextGitHubWebhookDelivery(
	ctx context.Context,
) (clouddomain.GitHubWebhookDelivery, bool, error) {
	delivery, err := scanGitHubWebhookDelivery(s.pool.QueryRow(ctx, `
		WITH candidate AS (
			SELECT github_delivery_id
			FROM ao_github_webhook_deliveries
			WHERE (
					status IN ('pending', 'retry')
					AND (next_attempt_at IS NULL OR next_attempt_at <= now())
				)
				OR (
					status = 'processing'
					AND processing_started_at <= now() - interval '5 minutes'
				)
			ORDER BY COALESCE(next_attempt_at, received_at), received_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE ao_github_webhook_deliveries delivery
		SET status = 'processing',
			attempt_count = delivery.attempt_count + 1,
			processing_started_at = now(),
			last_attempt_at = now(),
			updated_at = now()
		FROM candidate
		WHERE delivery.github_delivery_id = candidate.github_delivery_id
		RETURNING delivery.github_delivery_id, delivery.event, delivery.action,
			delivery.github_installation_id, delivery.github_repository_id,
			delivery.payload, delivery.payload_hash, delivery.status,
			delivery.attempt_count, delivery.received_at,
			delivery.processing_started_at, delivery.last_attempt_at,
			delivery.processed_at, delivery.next_attempt_at, delivery.last_error,
			delivery.last_error_at, delivery.updated_at
	`))
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.GitHubWebhookDelivery{}, false, nil
	}
	if err != nil {
		return clouddomain.GitHubWebhookDelivery{}, false, fmt.Errorf("claim GitHub webhook delivery: %w", err)
	}
	return delivery, true, nil
}

// MarkGitHubWebhookDeliveryProcessed completes a claimed inbox item.
func (s *Store) MarkGitHubWebhookDeliveryProcessed(ctx context.Context, deliveryID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_github_webhook_deliveries
		SET status = 'processed',
			processed_at = now(),
			next_attempt_at = NULL,
			updated_at = now()
		WHERE github_delivery_id = $1 AND status = 'processing'
	`, deliveryID)
	if err != nil {
		return fmt.Errorf("complete GitHub webhook delivery: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrGitHubWebhookDeliveryNotProcessing
	}
	return nil
}

// MarkGitHubWebhookDeliveryFailed records an error and optionally schedules a
// retry. A nil retry time leaves the delivery terminally failed.
func (s *Store) MarkGitHubWebhookDeliveryFailed(
	ctx context.Context,
	deliveryID string,
	message string,
	retryAt *time.Time,
) error {
	if strings.TrimSpace(message) == "" {
		message = "webhook processing failed"
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_github_webhook_deliveries
		SET status = CASE WHEN $3::timestamptz IS NULL THEN 'failed' ELSE 'retry' END,
			next_attempt_at = $3,
			last_error = $2,
			last_error_at = now(),
			updated_at = now()
		WHERE github_delivery_id = $1 AND status = 'processing'
	`, deliveryID, message, retryAt)
	if err != nil {
		return fmt.Errorf("fail GitHub webhook delivery: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrGitHubWebhookDeliveryNotProcessing
	}
	return nil
}

type githubRowScanner interface {
	Scan(dest ...any) error
}

type githubRepositoryQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func newGitHubInstallState(reader io.Reader) (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(reader, raw); err != nil {
		return "", nil, fmt.Errorf("generate GitHub install state: %w", err)
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	return state, hashGitHubInstallState(state), nil
}

func hashGitHubInstallState(state string) []byte {
	hash := sha256.Sum256([]byte(state))
	return hash[:]
}

func hashGitHubWebhookPayload(payload []byte) []byte {
	hash := sha256.Sum256(payload)
	return hash[:]
}

func normalizeGitHubPendingInstallationInput(input *GitHubPendingInstallationInput) error {
	input.AccountLogin = strings.TrimSpace(input.AccountLogin)
	input.AccountType = strings.TrimSpace(input.AccountType)
	input.RepositorySelection = strings.TrimSpace(input.RepositorySelection)
	if input.InstallationID <= 0 ||
		input.AccountID <= 0 ||
		input.AccountLogin == "" ||
		input.AccountType == "" ||
		(input.RepositorySelection != "all" && input.RepositorySelection != "selected") ||
		input.RepositoryCount < 0 {
		return ErrInvalidGitHubInstallation
	}
	return nil
}

func matchesPendingGitHubConfirmation(
	attempt clouddomain.GitHubInstallAttempt,
	confirmation GitHubInstallationConfirmation,
) bool {
	input := confirmation.Installation
	return attempt.PendingGitHubInstallationID != nil &&
		*attempt.PendingGitHubInstallationID == input.InstallationID &&
		attempt.PendingGitHubAccountID != nil &&
		*attempt.PendingGitHubAccountID == input.AccountID &&
		attempt.PendingAccountLogin != nil &&
		*attempt.PendingAccountLogin == input.AccountLogin &&
		attempt.PendingAccountType != nil &&
		*attempt.PendingAccountType == input.AccountType &&
		attempt.PendingRepositorySelection != nil &&
		*attempt.PendingRepositorySelection == input.RepositorySelection &&
		attempt.PendingRepositoryCount != nil &&
		*attempt.PendingRepositoryCount == len(confirmation.Repositories)
}

func normalizeGitHubInstallationInput(input *GitHubInstallationInput) error {
	input.AccountLogin = strings.TrimSpace(input.AccountLogin)
	input.AccountType = strings.TrimSpace(input.AccountType)
	input.Status = strings.TrimSpace(input.Status)
	input.RepositorySelection = strings.TrimSpace(input.RepositorySelection)
	if input.Status == "" {
		input.Status = "active"
	}
	if len(input.Permissions) == 0 {
		input.Permissions = json.RawMessage(`{}`)
	}
	if input.Events == nil {
		input.Events = []string{}
	}
	if input.InstallationID <= 0 ||
		input.AccountID <= 0 ||
		input.AccountLogin == "" ||
		input.AccountType == "" ||
		!validGitHubInstallationStatus(input.Status) ||
		(input.RepositorySelection != "all" && input.RepositorySelection != "selected") ||
		!json.Valid(input.Permissions) {
		return ErrInvalidGitHubInstallation
	}
	return nil
}

func validGitHubInstallationStatus(status string) bool {
	switch status {
	case "active", "suspended", "disconnected", "deleted":
		return true
	default:
		return false
	}
}

func normalizeGitHubRepository(repository *clouddomain.GitHubRepository) error {
	repository.Name = strings.TrimSpace(repository.Name)
	repository.FullName = strings.TrimSpace(repository.FullName)
	repository.HTMLURL = strings.TrimSpace(repository.HTMLURL)
	repository.CloneURL = strings.TrimSpace(repository.CloneURL)
	repository.SSHURL = strings.TrimSpace(repository.SSHURL)
	repository.DefaultBranch = strings.TrimSpace(repository.DefaultBranch)
	repository.Visibility = strings.TrimSpace(repository.Visibility)
	if repository.DefaultBranch == "" {
		repository.DefaultBranch = "main"
	}
	if len(repository.Metadata) == 0 {
		repository.Metadata = json.RawMessage(`{}`)
	}
	if repository.ID <= 0 ||
		repository.OwnerAccountID <= 0 ||
		repository.Name == "" ||
		repository.FullName == "" ||
		repository.HTMLURL == "" ||
		repository.CloneURL == "" ||
		!json.Valid(repository.Metadata) {
		return ErrInvalidGitHubRepository
	}
	return nil
}

func upsertGitHubRepository(
	ctx context.Context,
	querier githubRepositoryQuerier,
	repository clouddomain.GitHubRepository,
) (clouddomain.GitHubRepository, error) {
	if err := normalizeGitHubRepository(&repository); err != nil {
		return clouddomain.GitHubRepository{}, err
	}
	result, err := scanGitHubRepository(querier.QueryRow(ctx, `
		INSERT INTO ao_github_repositories (
			github_repository_id, github_owner_account_id, name, full_name,
			html_url, clone_url, ssh_url, default_branch, visibility, is_private,
			is_archived, is_disabled, metadata, github_updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		ON CONFLICT (github_repository_id) DO UPDATE
		SET github_owner_account_id = EXCLUDED.github_owner_account_id,
			name = EXCLUDED.name,
			full_name = EXCLUDED.full_name,
			html_url = EXCLUDED.html_url,
			clone_url = EXCLUDED.clone_url,
			ssh_url = EXCLUDED.ssh_url,
			default_branch = EXCLUDED.default_branch,
			visibility = EXCLUDED.visibility,
			is_private = EXCLUDED.is_private,
			is_archived = EXCLUDED.is_archived,
			is_disabled = EXCLUDED.is_disabled,
			metadata = EXCLUDED.metadata,
			github_updated_at = EXCLUDED.github_updated_at,
			last_synced_at = now()
		RETURNING github_repository_id, github_owner_account_id, name, full_name,
			html_url, clone_url, ssh_url, default_branch, visibility, is_private,
			is_archived, is_disabled, metadata, github_updated_at, first_seen_at,
			last_synced_at
	`, repository.ID, repository.OwnerAccountID, repository.Name,
		repository.FullName, repository.HTMLURL, repository.CloneURL,
		repository.SSHURL, repository.DefaultBranch, repository.Visibility,
		repository.Private, repository.Archived, repository.Disabled,
		repository.Metadata, repository.GitHubUpdatedAt))
	if err != nil {
		return clouddomain.GitHubRepository{}, fmt.Errorf("upsert GitHub repository: %w", err)
	}
	return result, nil
}

func scanGitHubInstallAttempt(row githubRowScanner) (clouddomain.GitHubInstallAttempt, error) {
	var attempt clouddomain.GitHubInstallAttempt
	err := row.Scan(
		&attempt.ID,
		&attempt.OrgID,
		&attempt.InitiatingUserID,
		&attempt.StateHash,
		&attempt.Metadata,
		&attempt.PendingGitHubInstallationID,
		&attempt.PendingGitHubAccountID,
		&attempt.PendingAccountLogin,
		&attempt.PendingAccountType,
		&attempt.PendingRepositorySelection,
		&attempt.PendingRepositoryCount,
		&attempt.PendingRecordedAt,
		&attempt.ExpiresAt,
		&attempt.ConsumedAt,
		&attempt.CreatedAt,
	)
	return attempt, err
}

func scanGitHubInstallation(row githubRowScanner) (clouddomain.GitHubInstallation, error) {
	var installation clouddomain.GitHubInstallation
	err := row.Scan(
		&installation.ID,
		&installation.OrgID,
		&installation.GitHubInstallationID,
		&installation.GitHubAccountID,
		&installation.AccountLogin,
		&installation.AccountType,
		&installation.Status,
		&installation.RepositorySelection,
		&installation.Permissions,
		&installation.Events,
		&installation.InstalledByUserID,
		&installation.SuspendedAt,
		&installation.DisconnectedAt,
		&installation.DeletedAt,
		&installation.CreatedAt,
		&installation.UpdatedAt,
	)
	return installation, err
}

func scanGitHubRepository(row githubRowScanner) (clouddomain.GitHubRepository, error) {
	var repository clouddomain.GitHubRepository
	err := row.Scan(
		&repository.ID,
		&repository.OwnerAccountID,
		&repository.Name,
		&repository.FullName,
		&repository.HTMLURL,
		&repository.CloneURL,
		&repository.SSHURL,
		&repository.DefaultBranch,
		&repository.Visibility,
		&repository.Private,
		&repository.Archived,
		&repository.Disabled,
		&repository.Metadata,
		&repository.GitHubUpdatedAt,
		&repository.FirstSeenAt,
		&repository.LastSyncedAt,
	)
	return repository, err
}

func scanGitHubRepositoryGrant(row githubRowScanner) (clouddomain.GitHubRepositoryGrant, error) {
	var grant clouddomain.GitHubRepositoryGrant
	err := row.Scan(
		&grant.ID,
		&grant.OrgID,
		&grant.InstallationID,
		&grant.GitHubInstallationID,
		&grant.GitHubRepositoryID,
		&grant.RepositorySelection,
		&grant.GrantedAt,
		&grant.LastSyncedAt,
		&grant.RevokedAt,
		&grant.RevokeReason,
		&grant.Metadata,
	)
	return grant, err
}

func scanGitHubGrantedRepository(row githubRowScanner) (clouddomain.GitHubGrantedRepository, error) {
	var item clouddomain.GitHubGrantedRepository
	err := row.Scan(
		&item.Repository.ID,
		&item.Repository.OwnerAccountID,
		&item.Repository.Name,
		&item.Repository.FullName,
		&item.Repository.HTMLURL,
		&item.Repository.CloneURL,
		&item.Repository.SSHURL,
		&item.Repository.DefaultBranch,
		&item.Repository.Visibility,
		&item.Repository.Private,
		&item.Repository.Archived,
		&item.Repository.Disabled,
		&item.Repository.Metadata,
		&item.Repository.GitHubUpdatedAt,
		&item.Repository.FirstSeenAt,
		&item.Repository.LastSyncedAt,
		&item.Grant.ID,
		&item.Grant.OrgID,
		&item.Grant.InstallationID,
		&item.Grant.GitHubInstallationID,
		&item.Grant.GitHubRepositoryID,
		&item.Grant.RepositorySelection,
		&item.Grant.GrantedAt,
		&item.Grant.LastSyncedAt,
		&item.Grant.RevokedAt,
		&item.Grant.RevokeReason,
		&item.Grant.Metadata,
	)
	return item, err
}

func scanGitHubWebhookDelivery(row githubRowScanner) (clouddomain.GitHubWebhookDelivery, error) {
	var delivery clouddomain.GitHubWebhookDelivery
	err := row.Scan(
		&delivery.DeliveryID,
		&delivery.Event,
		&delivery.Action,
		&delivery.InstallationID,
		&delivery.RepositoryID,
		&delivery.Payload,
		&delivery.PayloadHash,
		&delivery.Status,
		&delivery.AttemptCount,
		&delivery.ReceivedAt,
		&delivery.ProcessingStartedAt,
		&delivery.LastAttemptAt,
		&delivery.ProcessedAt,
		&delivery.NextAttemptAt,
		&delivery.LastError,
		&delivery.LastErrorAt,
		&delivery.UpdatedAt,
	)
	return delivery, err
}

func validateGitHubWebhookDeliveryInput(input GitHubWebhookDeliveryInput) error {
	if strings.TrimSpace(input.DeliveryID) == "" ||
		strings.TrimSpace(input.Event) == "" ||
		len(input.Payload) == 0 ||
		(input.InstallationID != nil && *input.InstallationID <= 0) ||
		(input.RepositoryID != nil && *input.RepositoryID <= 0) {
		return ErrInvalidGitHubWebhookDelivery
	}
	return nil
}

func sameGitHubWebhookDelivery(
	existing clouddomain.GitHubWebhookDelivery,
	input GitHubWebhookDeliveryInput,
	hash []byte,
) bool {
	return existing.DeliveryID == input.DeliveryID &&
		existing.Event == input.Event &&
		existing.Action == input.Action &&
		equalOptionalInt64(existing.InstallationID, input.InstallationID) &&
		equalOptionalInt64(existing.RepositoryID, input.RepositoryID) &&
		bytes.Equal(existing.PayloadHash, hash)
}

func equalOptionalInt64(left, right *int64) bool {
	switch {
	case left == nil && right == nil:
		return true
	case left == nil || right == nil:
		return false
	default:
		return *left == *right
	}
}

var (
	// ErrInvalidGitHubInstallAttempt means the state is invalid, expired, used,
	// or outside the requested organization.
	ErrInvalidGitHubInstallAttempt = errors.New("GitHub install attempt is invalid or expired")
	// ErrGitHubInstallAttemptConflict means another installation already won the setup callback.
	ErrGitHubInstallAttemptConflict = errors.New("GitHub install attempt already has another installation")
	// ErrInvalidGitHubInstallation means installation metadata is invalid.
	ErrInvalidGitHubInstallation = errors.New("GitHub installation is invalid")
	// ErrGitHubInstallationConflict means an installation belongs to another AO organization.
	ErrGitHubInstallationConflict = errors.New("GitHub installation is already bound to another organization")
	// ErrGitHubInstallationNotFound means the org does not own an eligible installation.
	ErrGitHubInstallationNotFound = errors.New("GitHub installation not found")
	// ErrInvalidGitHubRepository means repository metadata is invalid.
	ErrInvalidGitHubRepository = errors.New("GitHub repository is invalid")
	// ErrGitHubRepositoryGrantNotFound means no active grant exists in the organization.
	ErrGitHubRepositoryGrantNotFound = errors.New("active GitHub repository grant not found")
	// ErrInvalidGitHubWebhookDelivery means required webhook metadata is invalid.
	ErrInvalidGitHubWebhookDelivery = errors.New("GitHub webhook delivery is invalid")
	// ErrGitHubWebhookReplayConflict means a delivery ID was reused for another payload.
	ErrGitHubWebhookReplayConflict = errors.New("GitHub webhook delivery replay conflicts with stored payload")
	// ErrGitHubWebhookDeliveryNotProcessing means a process-state transition was invalid.
	ErrGitHubWebhookDeliveryNotProcessing = errors.New("GitHub webhook delivery is not processing")
)
