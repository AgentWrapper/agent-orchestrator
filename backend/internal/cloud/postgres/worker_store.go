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
	AccountID             clouddomain.AccountID `json:"accountId"`
	Session               clouddomain.Session   `json:"session"`
	RepositoryURL         string                `json:"repositoryUrl"`
	DefaultBranch         string                `json:"defaultBranch"`
	ProjectConfig         []byte                `json:"projectConfig"`
	PendingPromptSequence int64                 `json:"pendingPromptSequence,omitempty"`
	PendingPrompt         string                `json:"pendingPrompt,omitempty"`
	CommandGuardEnabled   bool                  `json:"commandGuardEnabled"`
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
			project.config,
			COALESCE(turn.user_message_sequence, 0),
			COALESCE(prompt.payload->>'text', ''),
			COALESCE(turn.command_guard_enabled, false)
		FROM ao_sessions session
		JOIN ao_projects project ON project.id = session.project_id
		LEFT JOIN ao_turns turn
			ON turn.session_id = session.id
			AND turn.org_id = session.org_id
			AND turn.state IN ('queued', 'provisioning', 'running', 'cancel_requested')
		LEFT JOIN ao_events prompt
			ON prompt.session_id = session.id
			AND prompt.org_id = session.org_id
			AND prompt.sequence = turn.user_message_sequence
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
		&spec.PendingPromptSequence,
		&spec.PendingPrompt,
		&spec.CommandGuardEnabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkerLaunchSpec{}, ErrSessionNotFound
	}
	if err != nil {
		return WorkerLaunchSpec{}, fmt.Errorf("load worker launch spec: %w", err)
	}
	return spec, nil
}

// UpdateActiveTurnCommandGuard persists the guard mode that must apply while
// the current prompt is executed, including after worker restarts.
func (s *Store) UpdateActiveTurnCommandGuard(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	enabled bool,
) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ao_turns
		SET command_guard_enabled = $3, updated_at = now()
		WHERE org_id = $1
			AND session_id = $2
			AND state IN ('queued', 'provisioning', 'running', 'cancel_requested')
	`, accountID, sessionID, enabled)
	if err != nil {
		return fmt.Errorf("update active turn command guard: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrActiveTurnNotFound
	}
	return nil
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
