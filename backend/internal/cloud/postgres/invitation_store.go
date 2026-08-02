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

type CreateOrgInvitationInput struct {
	Email           string
	InvitedByUserID clouddomain.UserID
	Role            string
	ExpiresAt       time.Time
}

func (s *Store) CreateOrgInvitation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	input CreateOrgInvitationInput,
) (clouddomain.OrgInvitation, error) {
	if input.ExpiresAt.IsZero() {
		input.ExpiresAt = time.Now().Add(14 * 24 * time.Hour)
	}
	var invite clouddomain.OrgInvitation
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_org_invitations (
			org_id, email, invited_user_id, invited_by_user_id, role, expires_at
		)
		VALUES (
			$1,
			lower($2),
			(SELECT id FROM ao_users WHERE lower(email) = lower($2) LIMIT 1),
			$3,
			$4,
			$5
		)
		RETURNING id, org_id, email, COALESCE(invited_user_id::text, ''),
			invited_by_user_id, role, status, expires_at, accepted_at, declined_at,
			revoked_at, created_at, updated_at
	`, orgID, input.Email, input.InvitedByUserID, input.Role, input.ExpiresAt).Scan(
		&invite.ID,
		&invite.OrgID,
		&invite.Email,
		&invite.InvitedUserID,
		&invite.InvitedByUserID,
		&invite.Role,
		&invite.Status,
		&invite.ExpiresAt,
		&invite.AcceptedAt,
		&invite.DeclinedAt,
		&invite.RevokedAt,
		&invite.CreatedAt,
		&invite.UpdatedAt,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.ConstraintName == "ao_org_invitations_one_pending_email" {
			return clouddomain.OrgInvitation{}, ErrOrgInvitationExists
		}
		return clouddomain.OrgInvitation{}, fmt.Errorf("create org invitation: %w", err)
	}
	return invite, nil
}

func (s *Store) ListOrgInvitations(
	ctx context.Context,
	orgID clouddomain.OrgID,
) ([]clouddomain.OrgInvitation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, email, COALESCE(invited_user_id::text, ''),
			invited_by_user_id, role, status, expires_at, accepted_at, declined_at,
			revoked_at, created_at, updated_at
		FROM ao_org_invitations
		WHERE org_id = $1
		ORDER BY created_at DESC
	`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list org invitations: %w", err)
	}
	defer rows.Close()
	return scanInvitations(rows)
}

func (s *Store) ListUserInvitations(
	ctx context.Context,
	userID string,
	email string,
) ([]clouddomain.OrgInvitation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, email, COALESCE(invited_user_id::text, ''),
			invited_by_user_id, role, status, expires_at, accepted_at, declined_at,
			revoked_at, created_at, updated_at
		FROM ao_org_invitations
		WHERE status = 'pending'
			AND expires_at > now()
			AND (
				invited_user_id = $1
				OR lower(email) = lower($2)
			)
		ORDER BY created_at DESC
	`, userID, email)
	if err != nil {
		return nil, fmt.Errorf("list user invitations: %w", err)
	}
	defer rows.Close()
	return scanInvitations(rows)
}

func (s *Store) AcceptOrgInvitation(
	ctx context.Context,
	userID string,
	email string,
	invitationID string,
) (clouddomain.OrgMembership, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.OrgMembership{}, fmt.Errorf("begin accept org invitation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var invite clouddomain.OrgInvitation
	err = tx.QueryRow(ctx, `
		UPDATE ao_org_invitations
		SET status = 'accepted',
			invited_user_id = $2,
			accepted_at = now(),
			updated_at = now()
		WHERE id = $1
			AND status = 'pending'
			AND expires_at > now()
			AND (invited_user_id = $2 OR lower(email) = lower($3))
		RETURNING id, org_id, email, COALESCE(invited_user_id::text, ''),
			invited_by_user_id, role, status, expires_at, accepted_at, declined_at,
			revoked_at, created_at, updated_at
	`, invitationID, userID, email).Scan(
		&invite.ID,
		&invite.OrgID,
		&invite.Email,
		&invite.InvitedUserID,
		&invite.InvitedByUserID,
		&invite.Role,
		&invite.Status,
		&invite.ExpiresAt,
		&invite.AcceptedAt,
		&invite.DeclinedAt,
		&invite.RevokedAt,
		&invite.CreatedAt,
		&invite.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.OrgMembership{}, ErrOrgInvitationNotFound
	}
	if err != nil {
		return clouddomain.OrgMembership{}, fmt.Errorf("accept org invitation: %w", err)
	}
	var membership clouddomain.OrgMembership
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_org_memberships (org_id, user_id, role, status)
		VALUES ($1, $2, $3, 'active')
		ON CONFLICT (org_id, user_id) DO UPDATE
		SET role = EXCLUDED.role,
			status = 'active',
			updated_at = now()
		RETURNING id, org_id, user_id, COALESCE(external_membership_id, ''),
			role, status, created_at, updated_at
	`, invite.OrgID, userID, invite.Role).Scan(
		&membership.ID,
		&membership.OrgID,
		&membership.UserID,
		&membership.ExternalMembershipID,
		&membership.Role,
		&membership.Status,
		&membership.CreatedAt,
		&membership.UpdatedAt,
	)
	if err != nil {
		return clouddomain.OrgMembership{}, fmt.Errorf("create org membership: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.OrgMembership{}, fmt.Errorf("commit accept org invitation: %w", err)
	}
	return membership, nil
}

func (s *Store) DeclineOrgInvitation(ctx context.Context, userID, email, invitationID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_org_invitations
		SET status = 'declined', declined_at = now(), updated_at = now()
		WHERE id = $1
			AND status = 'pending'
			AND (invited_user_id = $2 OR lower(email) = lower($3))
	`, invitationID, userID, email)
	if err != nil {
		return fmt.Errorf("decline org invitation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrOrgInvitationNotFound
	}
	return nil
}

func (s *Store) RevokeOrgInvitation(ctx context.Context, orgID clouddomain.OrgID, invitationID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_org_invitations
		SET status = 'revoked', revoked_at = now(), updated_at = now()
		WHERE org_id = $1 AND id = $2 AND status = 'pending'
	`, orgID, invitationID)
	if err != nil {
		return fmt.Errorf("revoke org invitation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrOrgInvitationNotFound
	}
	return nil
}

func scanInvitations(rows pgx.Rows) ([]clouddomain.OrgInvitation, error) {
	invites := make([]clouddomain.OrgInvitation, 0)
	for rows.Next() {
		var invite clouddomain.OrgInvitation
		if err := rows.Scan(
			&invite.ID,
			&invite.OrgID,
			&invite.Email,
			&invite.InvitedUserID,
			&invite.InvitedByUserID,
			&invite.Role,
			&invite.Status,
			&invite.ExpiresAt,
			&invite.AcceptedAt,
			&invite.DeclinedAt,
			&invite.RevokedAt,
			&invite.CreatedAt,
			&invite.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan org invitation: %w", err)
		}
		invite.Email = strings.ToLower(invite.Email)
		invites = append(invites, invite)
	}
	return invites, rows.Err()
}

var (
	ErrOrgInvitationExists   = errors.New("cloud organization invitation already exists")
	ErrOrgInvitationNotFound = errors.New("cloud organization invitation not found")
)
