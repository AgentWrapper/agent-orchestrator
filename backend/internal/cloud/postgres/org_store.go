package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// CreateOrganizationInput contains fields for a user-created organization.
type CreateOrganizationInput struct {
	UserID      string
	DisplayName string
	Kind        string
}

// UpdateOrganizationInput contains editable organization fields.
type UpdateOrganizationInput struct {
	DisplayName string
}

// CreateOrganization creates an organization and owner membership for a user.
func (s *Store) CreateOrganization(
	ctx context.Context,
	input CreateOrganizationInput,
) (clouddomain.UserOrganization, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return clouddomain.UserOrganization{}, ErrInvalidOrganization
	}
	kind := strings.TrimSpace(input.Kind)
	if kind == "" {
		kind = "team"
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.UserOrganization{}, fmt.Errorf("begin create organization: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var account clouddomain.Account
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_accounts (owner_user_id, display_name)
		VALUES ($1, $2)
		RETURNING id, owner_user_id, display_name, created_at, updated_at
	`, input.UserID, displayName).Scan(
		&account.ID,
		&account.OwnerUserID,
		&account.DisplayName,
		&account.CreatedAt,
		&account.UpdatedAt,
	)
	if err != nil {
		return clouddomain.UserOrganization{}, fmt.Errorf("create organization account: %w", err)
	}
	slug := slug(displayName) + "-" + strings.ReplaceAll(string(account.ID)[:8], "-", "")
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_organizations (
			id, auth_provider, external_org_id, slug, display_name, kind, plan, status, created_by_user_id
		)
		VALUES ($1::uuid, 'local', $1, $2, $3, $4, 'free', 'active', $5)
	`, account.ID, slug, displayName, kind, input.UserID); err != nil {
		return clouddomain.UserOrganization{}, fmt.Errorf("create organization: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_org_memberships (org_id, user_id, role, status)
		VALUES ($1, $2, 'owner', 'active')
	`, account.ID, input.UserID); err != nil {
		return clouddomain.UserOrganization{}, fmt.Errorf("create organization owner membership: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.UserOrganization{}, fmt.Errorf("commit create organization: %w", err)
	}
	return s.GetOrgMembership(ctx, input.UserID, clouddomain.OrgID(account.ID))
}

// UpdateOrganization updates mutable organization metadata.
func (s *Store) UpdateOrganization(
	ctx context.Context,
	orgID clouddomain.OrgID,
	input UpdateOrganizationInput,
) (clouddomain.Organization, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return clouddomain.Organization{}, ErrInvalidOrganization
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return clouddomain.Organization{}, fmt.Errorf("begin update organization: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var org clouddomain.Organization
	var createdBy string
	err = tx.QueryRow(ctx, `
		UPDATE ao_organizations
		SET display_name = $2, updated_at = now()
		WHERE id = $1 AND status = 'active'
		RETURNING id, auth_provider, COALESCE(external_org_id, ''), slug,
			display_name, kind, plan, status, COALESCE(created_by_user_id::text, ''),
			created_at, updated_at
	`, orgID, displayName).Scan(
		&org.ID,
		&org.AuthProvider,
		&org.ExternalOrgID,
		&org.Slug,
		&org.DisplayName,
		&org.Kind,
		&org.Plan,
		&org.Status,
		&createdBy,
		&org.CreatedAt,
		&org.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.Organization{}, ErrOrganizationNotFound
	}
	if err != nil {
		return clouddomain.Organization{}, fmt.Errorf("update organization: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_accounts
		SET display_name = $2, updated_at = now()
		WHERE id = $1
	`, orgID, displayName); err != nil {
		return clouddomain.Organization{}, fmt.Errorf("update organization account: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return clouddomain.Organization{}, fmt.Errorf("commit update organization: %w", err)
	}
	org.CreatedByUserID = clouddomain.UserID(createdBy)
	return org, nil
}

// ListUserOrganizations returns the active organizations a user belongs to.
func (s *Store) ListUserOrganizations(ctx context.Context, userID string) ([]clouddomain.UserOrganization, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT
			org.id, org.auth_provider, COALESCE(org.external_org_id, ''), org.slug,
			org.display_name, org.kind, org.plan, org.status,
			COALESCE(org.created_by_user_id::text, ''), org.created_at, org.updated_at,
			membership.id, membership.org_id, membership.user_id,
			COALESCE(membership.external_membership_id, ''), membership.role,
			membership.status, membership.created_at, membership.updated_at
		FROM ao_org_memberships membership
		JOIN ao_organizations org ON org.id = membership.org_id
		WHERE membership.user_id = $1
			AND membership.status = 'active'
			AND org.status = 'active'
		ORDER BY org.kind = 'personal' DESC, org.created_at
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list user organizations: %w", err)
	}
	defer rows.Close()
	out := make([]clouddomain.UserOrganization, 0)
	for rows.Next() {
		var item clouddomain.UserOrganization
		var createdBy string
		if err := rows.Scan(
			&item.Organization.ID,
			&item.Organization.AuthProvider,
			&item.Organization.ExternalOrgID,
			&item.Organization.Slug,
			&item.Organization.DisplayName,
			&item.Organization.Kind,
			&item.Organization.Plan,
			&item.Organization.Status,
			&createdBy,
			&item.Organization.CreatedAt,
			&item.Organization.UpdatedAt,
			&item.Membership.ID,
			&item.Membership.OrgID,
			&item.Membership.UserID,
			&item.Membership.ExternalMembershipID,
			&item.Membership.Role,
			&item.Membership.Status,
			&item.Membership.CreatedAt,
			&item.Membership.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan user organization: %w", err)
		}
		item.Organization.CreatedByUserID = clouddomain.UserID(createdBy)
		out = append(out, item)
	}
	return out, rows.Err()
}

var (
	// ErrInvalidOrganization means organization input failed validation.
	ErrInvalidOrganization = errors.New("cloud organization is invalid")
	// ErrOrganizationNotFound means the organization does not exist or is inactive.
	ErrOrganizationNotFound = errors.New("cloud organization not found")
)

// GetOrgMembership returns the user's active membership in an active organization.
func (s *Store) GetOrgMembership(
	ctx context.Context,
	userID string,
	orgID clouddomain.OrgID,
) (clouddomain.UserOrganization, error) {
	var item clouddomain.UserOrganization
	var createdBy string
	err := s.pool.QueryRow(ctx, `
		SELECT
			org.id, org.auth_provider, COALESCE(org.external_org_id, ''), org.slug,
			org.display_name, org.kind, org.plan, org.status,
			COALESCE(org.created_by_user_id::text, ''), org.created_at, org.updated_at,
			membership.id, membership.org_id, membership.user_id,
			COALESCE(membership.external_membership_id, ''), membership.role,
			membership.status, membership.created_at, membership.updated_at
		FROM ao_org_memberships membership
		JOIN ao_organizations org ON org.id = membership.org_id
		WHERE membership.user_id = $1
			AND membership.org_id = $2
			AND membership.status = 'active'
			AND org.status = 'active'
	`, userID, orgID).Scan(
		&item.Organization.ID,
		&item.Organization.AuthProvider,
		&item.Organization.ExternalOrgID,
		&item.Organization.Slug,
		&item.Organization.DisplayName,
		&item.Organization.Kind,
		&item.Organization.Plan,
		&item.Organization.Status,
		&createdBy,
		&item.Organization.CreatedAt,
		&item.Organization.UpdatedAt,
		&item.Membership.ID,
		&item.Membership.OrgID,
		&item.Membership.UserID,
		&item.Membership.ExternalMembershipID,
		&item.Membership.Role,
		&item.Membership.Status,
		&item.Membership.CreatedAt,
		&item.Membership.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.UserOrganization{}, ErrOrgMembershipNotFound
	}
	if err != nil {
		return clouddomain.UserOrganization{}, fmt.Errorf("get org membership: %w", err)
	}
	item.Organization.CreatedByUserID = clouddomain.UserID(createdBy)
	return item, nil
}

// ListOrgMembers returns active members for an organization.
func (s *Store) ListOrgMembers(ctx context.Context, orgID clouddomain.OrgID) ([]clouddomain.OrgMember, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT
			user_account.id, user_account.auth_provider, user_account.external_user_id,
			user_account.email, user_account.display_name, user_account.created_at, user_account.updated_at,
			membership.id, membership.org_id, membership.user_id,
			COALESCE(membership.external_membership_id, ''), membership.role,
			membership.status, membership.created_at, membership.updated_at
		FROM ao_org_memberships membership
		JOIN ao_users user_account ON user_account.id = membership.user_id
		WHERE membership.org_id = $1
			AND membership.status = 'active'
		ORDER BY
			CASE membership.role
				WHEN 'owner' THEN 1
				WHEN 'admin' THEN 2
				WHEN 'member' THEN 3
				ELSE 4
			END,
			lower(user_account.email)
	`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list org members: %w", err)
	}
	defer rows.Close()
	members := make([]clouddomain.OrgMember, 0)
	for rows.Next() {
		var member clouddomain.OrgMember
		if err := rows.Scan(
			&member.User.ID,
			&member.User.AuthProvider,
			&member.User.ExternalUserID,
			&member.User.Email,
			&member.User.DisplayName,
			&member.User.CreatedAt,
			&member.User.UpdatedAt,
			&member.Membership.ID,
			&member.Membership.OrgID,
			&member.Membership.UserID,
			&member.Membership.ExternalMembershipID,
			&member.Membership.Role,
			&member.Membership.Status,
			&member.Membership.CreatedAt,
			&member.Membership.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan org member: %w", err)
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

// UpdateOrgMemberRole changes a member's role and returns the updated member.
func (s *Store) UpdateOrgMemberRole(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID string,
	role string,
) (clouddomain.OrgMember, error) {
	var member clouddomain.OrgMember
	err := s.pool.QueryRow(ctx, `
		UPDATE ao_org_memberships
		SET role = $3, updated_at = now()
		WHERE org_id = $1
			AND user_id = $2
			AND status = 'active'
		RETURNING id, org_id, user_id, COALESCE(external_membership_id, ''),
			role, status, created_at, updated_at
	`, orgID, userID, role).Scan(
		&member.Membership.ID,
		&member.Membership.OrgID,
		&member.Membership.UserID,
		&member.Membership.ExternalMembershipID,
		&member.Membership.Role,
		&member.Membership.Status,
		&member.Membership.CreatedAt,
		&member.Membership.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return clouddomain.OrgMember{}, ErrOrgMembershipNotFound
	}
	if err != nil {
		return clouddomain.OrgMember{}, fmt.Errorf("update org member role: %w", err)
	}
	err = s.pool.QueryRow(ctx, `
		SELECT id, auth_provider, external_user_id, email, display_name, created_at, updated_at
		FROM ao_users
		WHERE id = $1
	`, userID).Scan(
		&member.User.ID,
		&member.User.AuthProvider,
		&member.User.ExternalUserID,
		&member.User.Email,
		&member.User.DisplayName,
		&member.User.CreatedAt,
		&member.User.UpdatedAt,
	)
	if err != nil {
		return clouddomain.OrgMember{}, fmt.Errorf("get updated org member user: %w", err)
	}
	return member, nil
}
