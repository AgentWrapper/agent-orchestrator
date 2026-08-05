package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// ProjectShareLink is a durable scoped sharing invitation.
type ProjectShareLink struct {
	ID              string                  `json:"id"`
	OrgID           clouddomain.OrgID       `json:"orgId"`
	ProjectID       clouddomain.ProjectID   `json:"projectId"`
	SessionID       clouddomain.SessionID   `json:"sessionId,omitempty"`
	PolicyID        string                  `json:"policyId,omitempty"`
	CreatedByUserID clouddomain.UserID      `json:"createdByUserId"`
	Role            string                  `json:"role"`
	Status          string                  `json:"status"`
	ExpiresAt       *time.Time              `json:"expiresAt,omitempty"`
	CreatedAt       time.Time               `json:"createdAt"`
	UpdatedAt       time.Time               `json:"updatedAt"`
	AccessScope     string                  `json:"accessScope"`
	Recipients      []ProjectShareRecipient `json:"recipients,omitempty"`
}

// ProjectShareRecipient restricts who can redeem a restricted share link.
type ProjectShareRecipient struct {
	ID            string            `json:"id"`
	ShareLinkID   string            `json:"shareLinkId"`
	RecipientType string            `json:"recipientType"`
	Email         string            `json:"email,omitempty"`
	OrgID         clouddomain.OrgID `json:"orgId,omitempty"`
	OrgName       string            `json:"orgName,omitempty"`
	CreatedAt     time.Time         `json:"createdAt"`
}

// CreateProjectShareLinkInput captures the access policy for a new share link.
type CreateProjectShareLinkInput struct {
	OrgID           clouddomain.OrgID
	ProjectID       clouddomain.ProjectID
	SessionID       clouddomain.SessionID
	CreatedByUserID clouddomain.UserID
	Role            string
	Token           string
	AccessScope     string
	PolicyID        string
	RecipientEmails []string
	RecipientOrgIDs []clouddomain.OrgID
}

// SharedProjectGrant is one project/session another user shared with this user.
type SharedProjectGrant struct {
	ID            string                         `json:"id"`
	OrgID         clouddomain.OrgID              `json:"orgId"`
	Project       clouddomain.Project            `json:"project"`
	Session       *clouddomain.Session           `json:"session,omitempty"`
	SessionRoles  []ProjectShareGrantSessionRole `json:"sessionRoles,omitempty"`
	PolicyID      string                         `json:"policyId,omitempty"`
	Role          string                         `json:"role"`
	SharedByEmail string                         `json:"sharedByEmail"`
	SharedByName  string                         `json:"sharedByName"`
	RedeemedAt    time.Time                      `json:"redeemedAt"`
}

// ProjectShareAccess is the owner/admin management view for a project's shares.
type ProjectShareAccess struct {
	Links    []ProjectShareLink   `json:"links"`
	Grants   []ProjectShareGrant  `json:"grants"`
	Policies []ProjectSharePolicy `json:"policies,omitempty"`
}

// ProjectShareGrant is an active redeemed share for one user.
type ProjectShareGrant struct {
	ID           string                         `json:"id"`
	User         clouddomain.User               `json:"user"`
	SessionID    clouddomain.SessionID          `json:"sessionId,omitempty"`
	SessionRoles []ProjectShareGrantSessionRole `json:"sessionRoles,omitempty"`
	PolicyID     string                         `json:"policyId,omitempty"`
	Role         string                         `json:"role"`
	Status       string                         `json:"status"`
	RedeemedAt   time.Time                      `json:"redeemedAt"`
	UpdatedAt    time.Time                      `json:"updatedAt"`
}

// ProjectShareGrantSessionRole grants one user access to one session.
type ProjectShareGrantSessionRole struct {
	SessionID clouddomain.SessionID `json:"sessionId"`
	Role      string                `json:"role"`
}

// ProjectSharePolicy is a named reusable access policy for standalone projects.
type ProjectSharePolicy struct {
	ID              string                         `json:"id"`
	OrgID           clouddomain.OrgID              `json:"orgId"`
	ProjectID       clouddomain.ProjectID          `json:"projectId"`
	CreatedByUserID clouddomain.UserID             `json:"createdByUserId"`
	Name            string                         `json:"name"`
	SandboxType     string                         `json:"sandboxType"`
	Status          string                         `json:"status"`
	SessionRoles    []ProjectShareGrantSessionRole `json:"sessionRoles,omitempty"`
	Links           []ProjectShareLink             `json:"links,omitempty"`
	Grants          []ProjectShareGrant            `json:"grants,omitempty"`
	CreatedAt       time.Time                      `json:"createdAt"`
	UpdatedAt       time.Time                      `json:"updatedAt"`
}

// CreateProjectSharePolicyInput captures a named access policy.
type CreateProjectSharePolicyInput struct {
	OrgID           clouddomain.OrgID
	ProjectID       clouddomain.ProjectID
	CreatedByUserID clouddomain.UserID
	Name            string
	SandboxType     string
	SessionRoles    []ProjectShareGrantSessionRole
}

// UpdateProjectSharePolicyInput changes a named access policy.
type UpdateProjectSharePolicyInput struct {
	Name         string
	SandboxType  string
	SessionRoles []ProjectShareGrantSessionRole
}

// CreateProjectShareLink stores a scoped share link.
func (s *Store) CreateProjectShareLink(
	ctx context.Context,
	input CreateProjectShareLinkInput,
) (ProjectShareLink, error) {
	if input.AccessScope == "" {
		input.AccessScope = "anyone"
	}
	hash := sha256.Sum256([]byte(input.Token))
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ProjectShareLink{}, fmt.Errorf("begin create project share link: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var link ProjectShareLink
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_project_share_links (
			org_id, project_id, session_id, created_by_user_id, token_hash, role, access_scope, policy_id
		)
		VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, NULLIF($8, '')::uuid)
		RETURNING id, org_id, project_id, COALESCE(session_id::text, ''), COALESCE(policy_id::text, ''),
			created_by_user_id, role, status, expires_at, created_at, updated_at, access_scope
	`, input.OrgID, input.ProjectID, string(input.SessionID), input.CreatedByUserID, hash[:], input.Role, input.AccessScope, input.PolicyID).Scan(
		&link.ID,
		&link.OrgID,
		&link.ProjectID,
		&link.SessionID,
		&link.PolicyID,
		&link.CreatedByUserID,
		&link.Role,
		&link.Status,
		&link.ExpiresAt,
		&link.CreatedAt,
		&link.UpdatedAt,
		&link.AccessScope,
	)
	if err != nil {
		return ProjectShareLink{}, fmt.Errorf("create project share link: %w", err)
	}
	recipients, err := insertProjectShareRecipients(ctx, tx, link.ID, input.RecipientEmails, input.RecipientOrgIDs)
	if err != nil {
		return ProjectShareLink{}, err
	}
	link.Recipients = recipients
	if err := tx.Commit(ctx); err != nil {
		return ProjectShareLink{}, fmt.Errorf("commit create project share link: %w", err)
	}
	return link, nil
}

func insertProjectShareRecipients(
	ctx context.Context,
	tx pgx.Tx,
	shareLinkID string,
	emails []string,
	orgIDs []clouddomain.OrgID,
) ([]ProjectShareRecipient, error) {
	recipients := make([]ProjectShareRecipient, 0, len(emails)+len(orgIDs))
	seenEmails := map[string]struct{}{}
	for _, rawEmail := range emails {
		email, err := normalizeShareEmail(rawEmail)
		if err != nil {
			return nil, err
		}
		if _, seen := seenEmails[email]; seen {
			continue
		}
		seenEmails[email] = struct{}{}
		var recipient ProjectShareRecipient
		if err := tx.QueryRow(ctx, `
			INSERT INTO ao_project_share_link_recipients (share_link_id, recipient_type, email)
			VALUES ($1, 'email', $2)
			RETURNING id, share_link_id, recipient_type, email, COALESCE(org_id::text, ''), '', created_at
		`, shareLinkID, email).Scan(
			&recipient.ID,
			&recipient.ShareLinkID,
			&recipient.RecipientType,
			&recipient.Email,
			&recipient.OrgID,
			&recipient.OrgName,
			&recipient.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("insert share email recipient: %w", err)
		}
		recipients = append(recipients, recipient)
	}
	seenOrgs := map[clouddomain.OrgID]struct{}{}
	for _, orgID := range orgIDs {
		if orgID == "" {
			continue
		}
		if _, seen := seenOrgs[orgID]; seen {
			continue
		}
		seenOrgs[orgID] = struct{}{}
		var recipient ProjectShareRecipient
		if err := tx.QueryRow(ctx, `
			INSERT INTO ao_project_share_link_recipients (share_link_id, recipient_type, org_id)
			VALUES ($1, 'org', $2)
			RETURNING id, share_link_id, recipient_type, '', org_id, '', created_at
		`, shareLinkID, orgID).Scan(
			&recipient.ID,
			&recipient.ShareLinkID,
			&recipient.RecipientType,
			&recipient.Email,
			&recipient.OrgID,
			&recipient.OrgName,
			&recipient.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("insert share org recipient: %w", err)
		}
		recipients = append(recipients, recipient)
	}
	return recipients, nil
}

func normalizeShareEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	if email == "" {
		return "", ErrProjectShareInvalidRecipient
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return "", ErrProjectShareInvalidRecipient
	}
	return email, nil
}

// RedeemProjectShareLink records access for the signed-in user.
func (s *Store) RedeemProjectShareLink(
	ctx context.Context,
	token string,
	userID string,
) (SharedProjectGrant, error) {
	hash := sha256.Sum256([]byte(token))
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SharedProjectGrant{}, fmt.Errorf("begin redeem share link: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var link ProjectShareLink
	err = tx.QueryRow(ctx, `
		SELECT id, org_id, project_id, COALESCE(session_id::text, ''), COALESCE(policy_id::text, ''),
			created_by_user_id, role, status, expires_at, created_at, updated_at, access_scope
		FROM ao_project_share_links
		WHERE token_hash = $1
			AND status = 'active'
			AND (expires_at IS NULL OR expires_at > now())
	`, hash[:]).Scan(
		&link.ID,
		&link.OrgID,
		&link.ProjectID,
		&link.SessionID,
		&link.PolicyID,
		&link.CreatedByUserID,
		&link.Role,
		&link.Status,
		&link.ExpiresAt,
		&link.CreatedAt,
		&link.UpdatedAt,
		&link.AccessScope,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SharedProjectGrant{}, ErrProjectShareLinkNotFound
	}
	if err != nil {
		return SharedProjectGrant{}, fmt.Errorf("load project share link: %w", err)
	}
	if string(link.CreatedByUserID) == userID {
		return SharedProjectGrant{}, ErrProjectShareSelfRedeem
	}
	if link.AccessScope == "restricted" {
		allowed, err := restrictedShareAllowsUser(ctx, tx, link.ID, userID)
		if err != nil {
			return SharedProjectGrant{}, err
		}
		if !allowed {
			return SharedProjectGrant{}, ErrProjectShareUnauthorized
		}
	}
	var grantID string
	err = tx.QueryRow(ctx, `
		INSERT INTO ao_project_share_grants (
			share_link_id, org_id, project_id, session_id, user_id, shared_by_user_id, role, policy_id
		)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid, $5, $6, $7, NULLIF($8, '')::uuid)
		ON CONFLICT (user_id, org_id, project_id) WHERE status = 'active'
		DO UPDATE SET
			share_link_id = EXCLUDED.share_link_id,
			session_id = EXCLUDED.session_id,
			shared_by_user_id = EXCLUDED.shared_by_user_id,
			policy_id = EXCLUDED.policy_id,
			role = EXCLUDED.role,
			updated_at = now()
		RETURNING id
	`, link.ID, link.OrgID, link.ProjectID, string(link.SessionID), userID, link.CreatedByUserID, link.Role, link.PolicyID).Scan(&grantID)
	if err != nil {
		return SharedProjectGrant{}, fmt.Errorf("upsert project share grant: %w", err)
	}
	if link.PolicyID != "" {
		if err := syncGrantSessionsFromPolicy(ctx, tx, grantID, link.PolicyID); err != nil {
			return SharedProjectGrant{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SharedProjectGrant{}, fmt.Errorf("commit redeem share link: %w", err)
	}
	grants, err := s.ListSharedProjectGrants(ctx, userID)
	if err != nil {
		return SharedProjectGrant{}, err
	}
	for _, grant := range grants {
		if grant.ID == grantID {
			return grant, nil
		}
	}
	return SharedProjectGrant{}, ErrProjectShareLinkNotFound
}

func restrictedShareAllowsUser(
	ctx context.Context,
	tx pgx.Tx,
	shareLinkID string,
	userID string,
) (bool, error) {
	var emailAllowed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM ao_project_share_link_recipients recipient
			JOIN ao_users user_row ON user_row.id = $2
			WHERE recipient.share_link_id = $1
				AND recipient.recipient_type = 'email'
				AND lower(recipient.email) = lower(user_row.email)
		)
	`, shareLinkID, userID).Scan(&emailAllowed); err != nil {
		return false, fmt.Errorf("check share email recipient: %w", err)
	}
	if emailAllowed {
		return true, nil
	}
	var orgAllowed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM ao_project_share_link_recipients recipient
			JOIN ao_org_memberships membership ON membership.org_id = recipient.org_id
			WHERE recipient.share_link_id = $1
				AND recipient.recipient_type = 'org'
				AND membership.user_id = $2
				AND membership.status = 'active'
		)
	`, shareLinkID, userID).Scan(&orgAllowed); err != nil {
		return false, fmt.Errorf("check share org recipient: %w", err)
	}
	return orgAllowed, nil
}

func syncGrantSessionsFromPolicy(ctx context.Context, tx pgx.Tx, grantID string, policyID string) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM ao_project_share_grant_sessions
		WHERE grant_id = $1
	`, grantID); err != nil {
		return fmt.Errorf("clear policy grant sessions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_project_share_grant_sessions (
			grant_id, org_id, project_id, session_id, role
		)
		SELECT $1, policy_session.org_id, policy_session.project_id,
			policy_session.session_id,
			CASE
				WHEN policy.sandbox_type = 'read_only' THEN 'viewer'
				ELSE policy_session.role
			END
		FROM ao_project_share_policy_sessions policy_session
		JOIN ao_project_share_policies policy ON policy.id = policy_session.policy_id
		WHERE policy_session.policy_id = $2
	`, grantID, policyID); err != nil {
		return fmt.Errorf("sync policy grant sessions: %w", err)
	}
	return nil
}

// ListProjectShareAccess returns active links and redeemed grants for one project.
func (s *Store) ListProjectShareAccess(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
) (ProjectShareAccess, error) {
	linkRows, err := s.pool.Query(ctx, `
		SELECT id, org_id, project_id, COALESCE(session_id::text, ''), COALESCE(policy_id::text, ''),
			created_by_user_id, role, status, expires_at, created_at, updated_at, access_scope
		FROM ao_project_share_links
		WHERE org_id = $1 AND project_id = $2 AND status = 'active'
		ORDER BY created_at DESC
	`, orgID, projectID)
	if err != nil {
		return ProjectShareAccess{}, fmt.Errorf("list project share links: %w", err)
	}
	defer linkRows.Close()
	access := ProjectShareAccess{Links: []ProjectShareLink{}, Grants: []ProjectShareGrant{}, Policies: []ProjectSharePolicy{}}
	for linkRows.Next() {
		var link ProjectShareLink
		if err := linkRows.Scan(
			&link.ID,
			&link.OrgID,
			&link.ProjectID,
			&link.SessionID,
			&link.PolicyID,
			&link.CreatedByUserID,
			&link.Role,
			&link.Status,
			&link.ExpiresAt,
			&link.CreatedAt,
			&link.UpdatedAt,
			&link.AccessScope,
		); err != nil {
			return ProjectShareAccess{}, fmt.Errorf("scan project share link: %w", err)
		}
		access.Links = append(access.Links, link)
	}
	if err := linkRows.Err(); err != nil {
		return ProjectShareAccess{}, err
	}
	if len(access.Links) > 0 {
		recipients, err := s.projectShareRecipients(ctx, access.Links)
		if err != nil {
			return ProjectShareAccess{}, err
		}
		for index := range access.Links {
			access.Links[index].Recipients = recipients[access.Links[index].ID]
		}
	}
	grantRows, err := s.pool.Query(ctx, `
		SELECT
			share_grant.id,
			COALESCE(share_grant.session_id::text, ''),
			COALESCE(share_grant.policy_id::text, ''),
			user_row.id, user_row.auth_provider, user_row.external_user_id, user_row.email,
			user_row.display_name, user_row.avatar_url, user_row.created_at, user_row.updated_at,
			share_grant.role, share_grant.status, share_grant.redeemed_at, share_grant.updated_at
		FROM ao_project_share_grants share_grant
		JOIN ao_users user_row ON user_row.id = share_grant.user_id
		WHERE share_grant.org_id = $1
			AND share_grant.project_id = $2
			AND share_grant.status = 'active'
		ORDER BY share_grant.redeemed_at DESC
	`, orgID, projectID)
	if err != nil {
		return ProjectShareAccess{}, fmt.Errorf("list project share grants: %w", err)
	}
	defer grantRows.Close()
	for grantRows.Next() {
		var grant ProjectShareGrant
		if err := grantRows.Scan(
			&grant.ID,
			&grant.SessionID,
			&grant.PolicyID,
			&grant.User.ID,
			&grant.User.AuthProvider,
			&grant.User.ExternalUserID,
			&grant.User.Email,
			&grant.User.DisplayName,
			&grant.User.AvatarURL,
			&grant.User.CreatedAt,
			&grant.User.UpdatedAt,
			&grant.Role,
			&grant.Status,
			&grant.RedeemedAt,
			&grant.UpdatedAt,
		); err != nil {
			return ProjectShareAccess{}, fmt.Errorf("scan project share grant: %w", err)
		}
		access.Grants = append(access.Grants, grant)
	}
	if err := grantRows.Err(); err != nil {
		return ProjectShareAccess{}, err
	}
	grantIDs := make([]string, 0, len(access.Grants))
	for _, grant := range access.Grants {
		grantIDs = append(grantIDs, grant.ID)
	}
	sessionRoles, err := s.projectShareGrantSessionRoles(ctx, grantIDs)
	if err != nil {
		return ProjectShareAccess{}, err
	}
	for index := range access.Grants {
		access.Grants[index].SessionRoles = sessionRoles[access.Grants[index].ID]
	}
	policies, err := s.listProjectSharePolicies(ctx, orgID, projectID)
	if err != nil {
		return ProjectShareAccess{}, err
	}
	policyByID := map[string]int{}
	for index := range policies {
		policyByID[policies[index].ID] = index
	}
	directLinks := make([]ProjectShareLink, 0, len(access.Links))
	for _, link := range access.Links {
		if link.PolicyID == "" {
			directLinks = append(directLinks, link)
			continue
		}
		if policyIndex, ok := policyByID[link.PolicyID]; ok {
			policies[policyIndex].Links = append(policies[policyIndex].Links, link)
		}
	}
	directGrants := make([]ProjectShareGrant, 0, len(access.Grants))
	for _, grant := range access.Grants {
		if grant.PolicyID == "" {
			directGrants = append(directGrants, grant)
			continue
		}
		if policyIndex, ok := policyByID[grant.PolicyID]; ok {
			policies[policyIndex].Grants = append(policies[policyIndex].Grants, grant)
		}
	}
	access.Links = directLinks
	access.Grants = directGrants
	access.Policies = policies
	return access, nil
}

func (s *Store) listProjectSharePolicies(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
) ([]ProjectSharePolicy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, project_id, created_by_user_id, name,
			sandbox_type, status, created_at, updated_at
		FROM ao_project_share_policies
		WHERE org_id = $1 AND project_id = $2 AND status = 'active'
		ORDER BY created_at DESC
	`, orgID, projectID)
	if err != nil {
		return nil, fmt.Errorf("list project share policies: %w", err)
	}
	defer rows.Close()
	policies := []ProjectSharePolicy{}
	for rows.Next() {
		var policy ProjectSharePolicy
		if err := rows.Scan(
			&policy.ID,
			&policy.OrgID,
			&policy.ProjectID,
			&policy.CreatedByUserID,
			&policy.Name,
			&policy.SandboxType,
			&policy.Status,
			&policy.CreatedAt,
			&policy.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan project share policy: %w", err)
		}
		policies = append(policies, policy)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range policies {
		sessionRoles, err := s.projectSharePolicySessionRoles(ctx, policies[index].ID)
		if err != nil {
			return nil, err
		}
		policies[index].SessionRoles = sessionRoles
	}
	return policies, nil
}

func (s *Store) projectSharePolicySessionRoles(
	ctx context.Context,
	policyID string,
) ([]ProjectShareGrantSessionRole, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT session_id, role
		FROM ao_project_share_policy_sessions
		WHERE policy_id = $1
		ORDER BY created_at
	`, policyID)
	if err != nil {
		return nil, fmt.Errorf("list project share policy sessions: %w", err)
	}
	defer rows.Close()
	sessionRoles := []ProjectShareGrantSessionRole{}
	for rows.Next() {
		var sessionRole ProjectShareGrantSessionRole
		if err := rows.Scan(&sessionRole.SessionID, &sessionRole.Role); err != nil {
			return nil, fmt.Errorf("scan project share policy session: %w", err)
		}
		sessionRoles = append(sessionRoles, sessionRole)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return sessionRoles, nil
}

func (s *Store) projectShareGrantSessionRoles(
	ctx context.Context,
	grantIDs []string,
) (map[string][]ProjectShareGrantSessionRole, error) {
	out := make(map[string][]ProjectShareGrantSessionRole, len(grantIDs))
	for _, grantID := range grantIDs {
		rows, err := s.pool.Query(ctx, `
			SELECT session_id, role
			FROM ao_project_share_grant_sessions
			WHERE grant_id = $1
			ORDER BY created_at
		`, grantID)
		if err != nil {
			return nil, fmt.Errorf("list project share grant sessions: %w", err)
		}
		for rows.Next() {
			var sessionRole ProjectShareGrantSessionRole
			if err := rows.Scan(&sessionRole.SessionID, &sessionRole.Role); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan project share grant session: %w", err)
			}
			out[grantID] = append(out[grantID], sessionRole)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

func (s *Store) projectShareRecipients(
	ctx context.Context,
	links []ProjectShareLink,
) (map[string][]ProjectShareRecipient, error) {
	out := make(map[string][]ProjectShareRecipient, len(links))
	for _, link := range links {
		rows, err := s.pool.Query(ctx, `
			SELECT
				recipient.id, recipient.share_link_id, recipient.recipient_type,
				COALESCE(recipient.email, ''), COALESCE(recipient.org_id::text, ''),
				COALESCE(org.display_name, ''), recipient.created_at
			FROM ao_project_share_link_recipients recipient
			LEFT JOIN ao_organizations org ON org.id = recipient.org_id
			WHERE recipient.share_link_id = $1
			ORDER BY recipient.created_at
		`, link.ID)
		if err != nil {
			return nil, fmt.Errorf("list share recipients: %w", err)
		}
		for rows.Next() {
			var recipient ProjectShareRecipient
			if err := rows.Scan(
				&recipient.ID,
				&recipient.ShareLinkID,
				&recipient.RecipientType,
				&recipient.Email,
				&recipient.OrgID,
				&recipient.OrgName,
				&recipient.CreatedAt,
			); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan share recipient: %w", err)
			}
			out[recipient.ShareLinkID] = append(out[recipient.ShareLinkID], recipient)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

// UpdateProjectShareGrantAccess changes one redeemed user's share role/scope.
func (s *Store) UpdateProjectShareGrantAccess(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	grantID string,
	role string,
	sessionID clouddomain.SessionID,
	policyID string,
	sessionRoles []ProjectShareGrantSessionRole,
) (ProjectShareGrant, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ProjectShareGrant{}, fmt.Errorf("begin update project share grant: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	nextSessionID := sessionID
	if len(sessionRoles) > 0 {
		nextSessionID = ""
	}
	tag, err := tx.Exec(ctx, `
		UPDATE ao_project_share_grants
		SET role = $4,
			session_id = NULLIF($5, '')::uuid,
			policy_id = NULLIF($6, '')::uuid,
			updated_at = now()
		WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
	`, orgID, projectID, grantID, role, string(nextSessionID), strings.TrimSpace(policyID))
	if err != nil {
		return ProjectShareGrant{}, fmt.Errorf("update project share grant: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ProjectShareGrant{}, ErrProjectShareGrantNotFound
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM ao_project_share_grant_sessions
		WHERE grant_id = $1
	`, grantID); err != nil {
		return ProjectShareGrant{}, fmt.Errorf("clear project share grant sessions: %w", err)
	}
	if strings.TrimSpace(policyID) != "" {
		if err := syncGrantSessionsFromPolicy(ctx, tx, grantID, strings.TrimSpace(policyID)); err != nil {
			return ProjectShareGrant{}, err
		}
	} else {
		for _, sessionRole := range sessionRoles {
			if _, err := tx.Exec(ctx, `
				INSERT INTO ao_project_share_grant_sessions (
					grant_id, org_id, project_id, session_id, role
				)
				VALUES ($1, $2, $3, $4, $5)
			`, grantID, orgID, projectID, sessionRole.SessionID, sessionRole.Role); err != nil {
				return ProjectShareGrant{}, fmt.Errorf("insert project share grant session: %w", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ProjectShareGrant{}, fmt.Errorf("commit update project share grant: %w", err)
	}
	access, err := s.ListProjectShareAccess(ctx, orgID, projectID)
	if err != nil {
		return ProjectShareGrant{}, err
	}
	for _, grant := range access.Grants {
		if grant.ID == grantID {
			return grant, nil
		}
	}
	for _, policy := range access.Policies {
		for _, grant := range policy.Grants {
			if grant.ID == grantID {
				return grant, nil
			}
		}
	}
	return ProjectShareGrant{}, ErrProjectShareGrantNotFound
}

// CreateProjectSharePolicy stores a named reusable project access policy.
func (s *Store) CreateProjectSharePolicy(
	ctx context.Context,
	input CreateProjectSharePolicyInput,
) (ProjectSharePolicy, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("begin create project share policy: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sandboxType := strings.TrimSpace(input.SandboxType)
	if sandboxType == "" {
		sandboxType = "standard"
	}
	var policy ProjectSharePolicy
	if err := tx.QueryRow(ctx, `
		INSERT INTO ao_project_share_policies (
			org_id, project_id, created_by_user_id, name, sandbox_type
		)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, org_id, project_id, created_by_user_id, name,
			sandbox_type, status, created_at, updated_at
	`, input.OrgID, input.ProjectID, input.CreatedByUserID, strings.TrimSpace(input.Name), sandboxType).Scan(
		&policy.ID,
		&policy.OrgID,
		&policy.ProjectID,
		&policy.CreatedByUserID,
		&policy.Name,
		&policy.SandboxType,
		&policy.Status,
		&policy.CreatedAt,
		&policy.UpdatedAt,
	); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("create project share policy: %w", err)
	}
	if err := replaceProjectSharePolicySessions(ctx, tx, policy.ID, input.OrgID, input.ProjectID, input.SessionRoles); err != nil {
		return ProjectSharePolicy{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("commit create project share policy: %w", err)
	}
	policy.SessionRoles = input.SessionRoles
	return policy, nil
}

// UpdateProjectSharePolicy changes a reusable project access policy.
func (s *Store) UpdateProjectSharePolicy(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	policyID string,
	input UpdateProjectSharePolicyInput,
) (ProjectSharePolicy, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("begin update project share policy: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sandboxType := strings.TrimSpace(input.SandboxType)
	if sandboxType == "" {
		sandboxType = "standard"
	}
	var policy ProjectSharePolicy
	if err := tx.QueryRow(ctx, `
		UPDATE ao_project_share_policies
		SET name = $4,
			sandbox_type = $5,
			updated_at = now()
		WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
		RETURNING id, org_id, project_id, created_by_user_id, name,
			sandbox_type, status, created_at, updated_at
	`, orgID, projectID, policyID, strings.TrimSpace(input.Name), sandboxType).Scan(
		&policy.ID,
		&policy.OrgID,
		&policy.ProjectID,
		&policy.CreatedByUserID,
		&policy.Name,
		&policy.SandboxType,
		&policy.Status,
		&policy.CreatedAt,
		&policy.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ProjectSharePolicy{}, ErrProjectSharePolicyNotFound
		}
		return ProjectSharePolicy{}, fmt.Errorf("update project share policy: %w", err)
	}
	if err := replaceProjectSharePolicySessions(ctx, tx, policy.ID, orgID, projectID, input.SessionRoles); err != nil {
		return ProjectSharePolicy{}, err
	}
	policyRole := "editor"
	if sandboxType == "read_only" {
		policyRole = "viewer"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_project_share_links
		SET role = $2, updated_at = now()
		WHERE policy_id = $1 AND status = 'active'
	`, policy.ID, policyRole); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("update project share policy link roles: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_project_share_grants
		SET role = $2,
			session_id = NULL,
			updated_at = now()
		WHERE policy_id = $1 AND status = 'active'
	`, policy.ID, policyRole); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("update project share policy grant roles: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM ao_project_share_grant_sessions
		WHERE grant_id IN (
			SELECT id
			FROM ao_project_share_grants
			WHERE policy_id = $1 AND status = 'active'
		)
	`, policy.ID); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("clear policy member sessions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ao_project_share_grant_sessions (
			grant_id, org_id, project_id, session_id, role
		)
		SELECT grant_row.id, policy_session.org_id, policy_session.project_id,
			policy_session.session_id,
			CASE
				WHEN policy.sandbox_type = 'read_only' THEN 'viewer'
				ELSE policy_session.role
			END
		FROM ao_project_share_grants grant_row
		JOIN ao_project_share_policies policy
			ON policy.id = grant_row.policy_id
		JOIN ao_project_share_policy_sessions policy_session
			ON policy_session.policy_id = grant_row.policy_id
		WHERE grant_row.policy_id = $1 AND grant_row.status = 'active'
	`, policy.ID); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("sync policy member sessions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ProjectSharePolicy{}, fmt.Errorf("commit update project share policy: %w", err)
	}
	policy.SessionRoles = input.SessionRoles
	return policy, nil
}

// ArchiveProjectSharePolicy disables a policy and revokes its links and members.
func (s *Store) ArchiveProjectSharePolicy(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	policyID string,
) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin archive project share policy: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE ao_project_share_policies
		SET status = 'archived', updated_at = now()
		WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
	`, orgID, projectID, policyID)
	if err != nil {
		return fmt.Errorf("archive project share policy: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrProjectSharePolicyNotFound
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_project_share_links
		SET status = 'revoked', updated_at = now()
		WHERE policy_id = $1 AND status = 'active'
	`, policyID); err != nil {
		return fmt.Errorf("archive project share policy links: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ao_project_share_grants
		SET status = 'revoked', updated_at = now()
		WHERE policy_id = $1 AND status = 'active'
	`, policyID); err != nil {
		return fmt.Errorf("archive project share policy grants: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit archive project share policy: %w", err)
	}
	return nil
}

func replaceProjectSharePolicySessions(
	ctx context.Context,
	tx pgx.Tx,
	policyID string,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	sessionRoles []ProjectShareGrantSessionRole,
) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM ao_project_share_policy_sessions
		WHERE policy_id = $1
	`, policyID); err != nil {
		return fmt.Errorf("clear project share policy sessions: %w", err)
	}
	for _, sessionRole := range sessionRoles {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ao_project_share_policy_sessions (
				policy_id, org_id, project_id, session_id, role
			)
			VALUES ($1, $2, $3, $4, $5)
		`, policyID, orgID, projectID, sessionRole.SessionID, sessionRole.Role); err != nil {
			return fmt.Errorf("insert project share policy session: %w", err)
		}
	}
	return nil
}

// RevokeProjectShareGrant removes one user's active shared-project access.
func (s *Store) RevokeProjectShareGrant(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	grantID string,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_project_share_grants
		SET status = 'revoked', updated_at = now()
		WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
	`, orgID, projectID, grantID)
	if err != nil {
		return fmt.Errorf("revoke project share grant: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrProjectShareGrantNotFound
	}
	return nil
}

// RevokeProjectShareLink disables future redemption for a share link.
func (s *Store) RevokeProjectShareLink(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	linkID string,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_project_share_links
		SET status = 'revoked', updated_at = now()
		WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
	`, orgID, projectID, linkID)
	if err != nil {
		return fmt.Errorf("revoke project share link: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrProjectShareLinkNotFound
	}
	return nil
}

// ListSharedProjectGrants returns scoped project shares visible to a user.
func (s *Store) ListSharedProjectGrants(ctx context.Context, userID string) ([]SharedProjectGrant, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT
			share_grant.id,
			share_grant.org_id,
			project.id, project.account_id, project.org_id, project.display_name,
			project.repository_url, project.default_branch, project.github_repository_id,
			project.config, project.created_at, project.updated_at,
			COALESCE(session.id::text, ''), COALESCE(session.account_id::text, ''),
			COALESCE(session.org_id::text, ''), COALESCE(session.project_id::text, ''),
			COALESCE(session.kind, ''), COALESCE(session.harness, ''),
			COALESCE(session.display_name, ''), COALESCE(session.branch, ''),
			COALESCE(session.activity_state, ''), COALESCE(session.is_terminated, false),
			COALESCE(session.agent_session_id, ''), COALESCE(session.created_at, now()),
			COALESCE(session.updated_at, now()),
			COALESCE(share_grant.policy_id::text, ''),
			share_grant.role,
			shared_by.email,
			shared_by.display_name,
			share_grant.redeemed_at
		FROM ao_project_share_grants share_grant
		JOIN ao_projects project ON project.id = share_grant.project_id AND project.org_id = share_grant.org_id
		LEFT JOIN ao_sessions session ON session.id = share_grant.session_id
		JOIN ao_users shared_by ON shared_by.id = share_grant.shared_by_user_id
		WHERE share_grant.user_id = $1
			AND share_grant.status = 'active'
		ORDER BY share_grant.redeemed_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list project share grants: %w", err)
	}
	defer rows.Close()
	out := make([]SharedProjectGrant, 0)
	for rows.Next() {
		var grant SharedProjectGrant
		var session clouddomain.Session
		var sessionID string
		var sessionAccountID string
		var sessionOrgID string
		var sessionProjectID string
		var githubRepositoryID *int64
		if err := rows.Scan(
			&grant.ID,
			&grant.OrgID,
			&grant.Project.ID,
			&grant.Project.AccountID,
			&grant.Project.OrgID,
			&grant.Project.DisplayName,
			&grant.Project.RepositoryURL,
			&grant.Project.DefaultBranch,
			&githubRepositoryID,
			&grant.Project.Config,
			&grant.Project.CreatedAt,
			&grant.Project.UpdatedAt,
			&sessionID,
			&sessionAccountID,
			&sessionOrgID,
			&sessionProjectID,
			&session.Kind,
			&session.Harness,
			&session.DisplayName,
			&session.Branch,
			&session.ActivityState,
			&session.IsTerminated,
			&session.AgentSessionID,
			&session.CreatedAt,
			&session.UpdatedAt,
			&grant.PolicyID,
			&grant.Role,
			&grant.SharedByEmail,
			&grant.SharedByName,
			&grant.RedeemedAt,
		); err != nil {
			return nil, fmt.Errorf("scan project share grant: %w", err)
		}
		grant.Project.GitHubRepositoryID = githubRepositoryID
		if sessionID != "" {
			session.ID = clouddomain.SessionID(sessionID)
			session.AccountID = clouddomain.AccountID(sessionAccountID)
			session.OrgID = clouddomain.OrgID(sessionOrgID)
			session.ProjectID = clouddomain.ProjectID(sessionProjectID)
			activeTurn, err := s.GetActiveTurn(ctx, clouddomain.AccountID(sessionOrgID), session.ID)
			if err != nil {
				return nil, err
			}
			session.ActiveTurn = activeTurn
			status, err := s.sessionStatus(ctx, clouddomain.AccountID(sessionOrgID), session)
			if err != nil {
				return nil, err
			}
			session.Status = status
			capabilities, connected, runtimeState, runtimeError, err := s.sessionRuntime(ctx, clouddomain.AccountID(sessionOrgID), session.ID)
			if err != nil {
				return nil, err
			}
			session.Capabilities = capabilities
			session.RuntimeConnected = connected
			session.RuntimeState = runtimeState
			session.RuntimeError = runtimeError
			grant.Session = &session
		}
		out = append(out, grant)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	grantIDs := make([]string, 0, len(out))
	for _, grant := range out {
		grantIDs = append(grantIDs, grant.ID)
	}
	sessionRoles, err := s.projectShareGrantSessionRoles(ctx, grantIDs)
	if err != nil {
		return nil, err
	}
	for index := range out {
		out[index].SessionRoles = sessionRoles[out[index].ID]
	}
	return out, nil
}

var (
	// ErrProjectShareLinkNotFound means the requested project share link does not exist.
	ErrProjectShareLinkNotFound = errors.New("cloud project share link not found")
	// ErrProjectShareGrantNotFound means the requested project share grant does not exist.
	ErrProjectShareGrantNotFound = errors.New("cloud project share grant not found")
	// ErrProjectSharePolicyNotFound means the requested project share policy does not exist.
	ErrProjectSharePolicyNotFound = errors.New("cloud project share policy not found")
	// ErrProjectShareSelfRedeem means the link creator attempted to redeem their own link.
	ErrProjectShareSelfRedeem = errors.New("cannot redeem own project share link")
	// ErrProjectShareUnauthorized means the current user is not an eligible link recipient.
	ErrProjectShareUnauthorized = errors.New("cloud project share link is restricted")
	// ErrProjectShareInvalidRecipient means the requested recipient email is invalid.
	ErrProjectShareInvalidRecipient = errors.New("cloud project share recipient is invalid")
)
