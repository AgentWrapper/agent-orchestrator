package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// WorkerLaunchSpec contains the durable inputs needed to launch a session worker.
type WorkerLaunchSpec struct {
	AccountID     clouddomain.AccountID `json:"accountId"`
	Session       clouddomain.Session   `json:"session"`
	RepositoryURL string                `json:"repositoryUrl"`
	DefaultBranch string                `json:"defaultBranch"`
	ProjectConfig []byte                `json:"projectConfig"`
}

// WorkerLaunchSpec returns launch data for an account-owned session.
func (s *Store) WorkerLaunchSpec(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) (WorkerLaunchSpec, error) {
	var spec WorkerLaunchSpec
	err := s.pool.QueryRow(ctx, `
		SELECT
			session.org_id,
			session.id,
			session.account_id,
			session.org_id,
			session.project_id,
			session.kind,
			session.harness,
			session.display_name,
			session.branch,
			session.prompt,
			session.activity_state,
			session.is_terminated,
			session.agent_session_id,
			session.created_at,
			session.updated_at,
			project.repository_url,
			project.default_branch,
			project.config
		FROM ao_sessions session
		JOIN ao_projects project ON project.id = session.project_id
		WHERE session.org_id = $1 AND session.id = $2
	`, accountID, sessionID).Scan(
		&spec.AccountID,
		&spec.Session.ID,
		&spec.Session.AccountID,
		&spec.Session.OrgID,
		&spec.Session.ProjectID,
		&spec.Session.Kind,
		&spec.Session.Harness,
		&spec.Session.DisplayName,
		&spec.Session.Branch,
		&spec.Session.Prompt,
		&spec.Session.ActivityState,
		&spec.Session.IsTerminated,
		&spec.Session.AgentSessionID,
		&spec.Session.CreatedAt,
		&spec.Session.UpdatedAt,
		&spec.RepositoryURL,
		&spec.DefaultBranch,
		&spec.ProjectConfig,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkerLaunchSpec{}, ErrSessionNotFound
	}
	if err != nil {
		return WorkerLaunchSpec{}, fmt.Errorf("load worker launch spec: %w", err)
	}
	return spec, nil
}

// UpdateSessionActivity records the latest worker-reported activity state.
func (s *Store) UpdateSessionActivity(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	state string,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_sessions
		SET activity_state = $3, updated_at = now()
		WHERE org_id = $1 AND id = $2
	`, accountID, sessionID, state)
	if err != nil {
		return fmt.Errorf("update cloud session activity: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// WorkerConnectionCurrent reports whether a worker still owns the active epoch.
func (s *Store) WorkerConnectionCurrent(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	workerID string,
	epoch int64,
) (bool, error) {
	var current bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM ao_worker_connections
			WHERE org_id = $1
				AND session_id = $2
				AND worker_id = $3
				AND epoch = $4
				AND disconnected_at IS NULL
		)
	`, accountID, sessionID, workerID, epoch).Scan(&current)
	if err != nil {
		return false, fmt.Errorf("validate worker connection epoch: %w", err)
	}
	return current, nil
}
