package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// ProjectShareLink is a durable scoped sharing invitation.
type ProjectShareLink struct {
	ID              string                `json:"id"`
	OrgID           clouddomain.OrgID     `json:"orgId"`
	ProjectID       clouddomain.ProjectID `json:"projectId"`
	SessionID       clouddomain.SessionID `json:"sessionId,omitempty"`
	CreatedByUserID clouddomain.UserID    `json:"createdByUserId"`
	Role            string                `json:"role"`
	Status          string                `json:"status"`
	ExpiresAt       *time.Time            `json:"expiresAt,omitempty"`
	CreatedAt       time.Time             `json:"createdAt"`
	UpdatedAt       time.Time             `json:"updatedAt"`
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

// CreateProjectShareLink stores a scoped share link.
func (s *Store) CreateProjectShareLink(
	ctx context.Context,
	orgID clouddomain.OrgID,
	projectID clouddomain.ProjectID,
	sessionID clouddomain.SessionID,
	createdByUserID clouddomain.UserID,
	role string,
	token string,
) (ProjectShareLink, error) {
	hash := sha256.Sum256([]byte(token))
	var link ProjectShareLink
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ao_project_share_links (
			org_id, project_id, session_id, created_by_user_id, token_hash, role
		)
		VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6)
		RETURNING id, org_id, project_id, COALESCE(session_id::text, ''),
			created_by_user_id, role, status, expires_at, created_at, updated_at
	`, orgID, projectID, string(sessionID), createdByUserID, hash[:], role).Scan(
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
	)
	if err != nil {
		return ProjectShareLink{}, fmt.Errorf("create project share link: %w", err)
	}
	return link, nil
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
			created_by_user_id, role, status, expires_at, created_at, updated_at
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
	ErrProjectShareLinkNotFound = errors.New("cloud project share link not found")
	ErrProjectShareSelfRedeem   = errors.New("cannot redeem own project share link")
)
