package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

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
