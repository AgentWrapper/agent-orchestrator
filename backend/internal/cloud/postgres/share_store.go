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
	RecipientEmails []string
	RecipientOrgIDs []clouddomain.OrgID
}

// SharedProjectGrant is one project/session another user shared with this user.
type SharedProjectGrant struct {
	ID            string               `json:"id"`
	OrgID         clouddomain.OrgID    `json:"orgId"`
	Project       clouddomain.Project  `json:"project"`
	Session       *clouddomain.Session `json:"session,omitempty"`
	Role          string               `json:"role"`
	SharedByEmail string               `json:"sharedByEmail"`
	SharedByName  string               `json:"sharedByName"`
	RedeemedAt    time.Time            `json:"redeemedAt"`
}

// ProjectShareAccess is the owner/admin management view for a project's shares.
type ProjectShareAccess struct {
	Links  []ProjectShareLink  `json:"links"`
	Grants []ProjectShareGrant `json:"grants"`
}

// ProjectShareGrant is an active redeemed share for one user.
type ProjectShareGrant struct {
	ID         string           `json:"id"`
	User       clouddomain.User `json:"user"`
	Role       string           `json:"role"`
	Status     string           `json:"status"`
	RedeemedAt time.Time        `json:"redeemedAt"`
	UpdatedAt  time.Time        `json:"updatedAt"`
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
			org_id, project_id, session_id, created_by_user_id, token_hash, role, access_scope
		)
		VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7)
		RETURNING id, org_id, project_id, COALESCE(session_id::text, ''),
			created_by_user_id, role, status, expires_at, created_at, updated_at, access_scope
	`, input.OrgID, input.ProjectID, string(input.SessionID), input.CreatedByUserID, hash[:], input.Role, input.AccessScope).Scan(
		&link.ID,
		&link.OrgID,
		&link.ProjectID,
		&link.SessionID,
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
		SELECT id, org_id, project_id, COALESCE(session_id::text, ''),
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
			share_link_id, org_id, project_id, session_id, user_id, shared_by_user_id, role
		)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid, $5, $6, $7)
		ON CONFLICT (user_id, org_id, project_id) WHERE status = 'active'
		DO UPDATE SET
			share_link_id = EXCLUDED.share_link_id,
			session_id = EXCLUDED.session_id,
			shared_by_user_id = EXCLUDED.shared_by_user_id,
			role = EXCLUDED.role,
			updated_at = now()
		RETURNING id
	`, link.ID, link.OrgID, link.ProjectID, string(link.SessionID), userID, link.CreatedByUserID, link.Role).Scan(&grantID)
	if err != nil {
		return SharedProjectGrant{}, fmt.Errorf("upsert project share grant: %w", err)
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

// ListProjectShareAccess returns active links and redeemed grants for one project.
func (s *Store) ListProjectShareAccess(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
) (ProjectShareAccess, error) {
	linkRows, err := s.pool.Query(ctx, `
		SELECT id, org_id, project_id, COALESCE(session_id::text, ''),
			created_by_user_id, role, status, expires_at, created_at, updated_at, access_scope
		FROM ao_project_share_links
		WHERE org_id = $1 AND project_id = $2 AND status = 'active'
		ORDER BY created_at DESC
	`, orgID, projectID)
	if err != nil {
		return ProjectShareAccess{}, fmt.Errorf("list project share links: %w", err)
	}
	defer linkRows.Close()
	access := ProjectShareAccess{Links: []ProjectShareLink{}, Grants: []ProjectShareGrant{}}
	for linkRows.Next() {
		var link ProjectShareLink
		if err := linkRows.Scan(
			&link.ID,
			&link.OrgID,
			&link.ProjectID,
			&link.SessionID,
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
	return access, grantRows.Err()
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

// UpdateProjectShareGrantRole changes one redeemed user's project share role.
func (s *Store) UpdateProjectShareGrantRole(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	grantID string,
	role string,
) (ProjectShareGrant, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_project_share_grants
		SET role = $4, updated_at = now()
		WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
	`, orgID, projectID, grantID, role)
	if err != nil {
		return ProjectShareGrant{}, fmt.Errorf("update project share grant: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ProjectShareGrant{}, ErrProjectShareGrantNotFound
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
	return ProjectShareGrant{}, ErrProjectShareGrantNotFound
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
			capabilities, connected, err := s.sessionRuntime(ctx, clouddomain.AccountID(sessionOrgID), session.ID)
			if err != nil {
				return nil, err
			}
			session.Capabilities = capabilities
			session.RuntimeConnected = connected
			grant.Session = &session
		}
		out = append(out, grant)
	}
	return out, rows.Err()
}

var (
	ErrProjectShareLinkNotFound     = errors.New("cloud project share link not found")
	ErrProjectShareGrantNotFound    = errors.New("cloud project share grant not found")
	ErrProjectShareSelfRedeem       = errors.New("cannot redeem own project share link")
	ErrProjectShareUnauthorized     = errors.New("cloud project share link is restricted")
	ErrProjectShareInvalidRecipient = errors.New("cloud project share recipient is invalid")
)
