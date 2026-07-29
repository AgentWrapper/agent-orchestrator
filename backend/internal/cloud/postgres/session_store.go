//nolint:revive // Store methods satisfy existing service interfaces; interface docs live at call sites.
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func (s *Store) CreateSession(ctx context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return domain.SessionRecord{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.SessionRecord{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, orgID+":"+string(rec.ProjectID)); err != nil {
		return domain.SessionRecord{}, err
	}
	var num int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(num), 0) + 1 FROM sessions WHERE org_id = $1 AND project_id = $2`, orgID, rec.ProjectID).Scan(&num); err != nil {
		return domain.SessionRecord{}, fmt.Errorf("next session num: %w", err)
	}
	rec.ID = domain.SessionID(fmt.Sprintf("%s-%d", rec.ProjectID, num))
	if err := insertSession(ctx, tx, orgID, rec, num); err != nil {
		return domain.SessionRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.SessionRecord{}, err
	}
	return rec, nil
}

func (s *Store) UpdateSession(ctx context.Context, rec domain.SessionRecord) error {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, sessionUpdateSQL, sessionUpdateArgs(orgID, rec)...)
	if err != nil {
		return fmt.Errorf("update session %s: %w", rec.ID, err)
	}
	return nil
}

func (s *Store) RenameSession(ctx context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE sessions SET display_name = $3, updated_at = $4 WHERE org_id = $1 AND id = $2`, orgID, id, displayName, updatedAt.UTC())
	if err != nil {
		return false, fmt.Errorf("rename session: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) SetSessionPreviewURL(ctx context.Context, id domain.SessionID, previewURL string, updatedAt time.Time) (bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE sessions SET preview_url = $3, preview_revision = preview_revision + 1, updated_at = $4 WHERE org_id = $1 AND id = $2`, orgID, id, previewURL, updatedAt.UTC())
	if err != nil {
		return false, fmt.Errorf("set session preview: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) SetSessionTerminateOnPRMerge(ctx context.Context, id domain.SessionID, terminate bool, updatedAt time.Time) (bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE sessions SET terminate_on_pr_merge = $3, updated_at = $4 WHERE org_id = $1 AND id = $2`, orgID, id, terminate, updatedAt.UTC())
	if err != nil {
		return false, fmt.Errorf("set merge policy: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) DeleteSession(ctx context.Context, id domain.SessionID) (bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `
DELETE FROM sessions
WHERE org_id = $1 AND id = $2 AND is_terminated = false
  AND workspace_path = '' AND runtime_handle_id = '' AND agent_session_id = '' AND prompt = ''
`, orgID, id)
	if err != nil {
		return false, fmt.Errorf("delete seed session: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return domain.SessionRecord{}, false, err
	}
	rec, err := s.querySession(ctx, `WHERE org_id = $1 AND id = $2`, orgID, id)
	if noRows(err) {
		return domain.SessionRecord{}, false, nil
	}
	if err != nil {
		return domain.SessionRecord{}, false, fmt.Errorf("get session %s: %w", id, err)
	}
	return rec, true, nil
}

func (s *Store) ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, sessionSelectSQL+`WHERE org_id = $1 AND project_id = $2 ORDER BY num`, orgID, project)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	return scanSessions(rows)
}

func (s *Store) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, sessionSelectSQL+`WHERE org_id = $1 ORDER BY project_id, num`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list all sessions: %w", err)
	}
	return scanSessions(rows)
}

const sessionSelectSQL = `
SELECT id, project_id, issue_id, kind, harness, display_name, activity_state, activity_last_at,
       first_signal_at, is_terminated, branch, workspace_path, workspace_repo_path,
       runtime_handle_id, runtime_launch_id, agent_session_id, prompt, preview_url,
       preview_revision, terminate_on_pr_merge, cleanup_generation, created_at, updated_at
FROM sessions
`

func (s *Store) querySession(ctx context.Context, where string, args ...any) (domain.SessionRecord, error) {
	return scanSession(s.db.QueryRowContext(ctx, sessionSelectSQL+where, args...))
}

func scanSessions(rows *sql.Rows) ([]domain.SessionRecord, error) {
	defer func() { _ = rows.Close() }()
	var out []domain.SessionRecord
	for rows.Next() {
		rec, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func scanSession(row scanner) (domain.SessionRecord, error) {
	var rec domain.SessionRecord
	var firstSignal sql.NullTime
	if err := row.Scan(
		&rec.ID, &rec.ProjectID, &rec.IssueID, &rec.Kind, &rec.Harness, &rec.DisplayName,
		&rec.Activity.State, &rec.Activity.LastActivityAt, &firstSignal, &rec.IsTerminated,
		&rec.Metadata.Branch, &rec.Metadata.WorkspacePath, &rec.Metadata.WorkspaceRepoPath,
		&rec.Metadata.RuntimeHandleID, &rec.Metadata.RuntimeLaunchID, &rec.Metadata.AgentSessionID,
		&rec.Metadata.Prompt, &rec.Metadata.PreviewURL, &rec.Metadata.PreviewRevision,
		&rec.TerminateOnPRMerge, &rec.CleanupGeneration, &rec.CreatedAt, &rec.UpdatedAt,
	); err != nil {
		return domain.SessionRecord{}, err
	}
	if firstSignal.Valid {
		rec.FirstSignalAt = firstSignal.Time
	}
	return rec, nil
}

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertSession(ctx context.Context, q execer, orgID string, rec domain.SessionRecord, num int64) error {
	activity := rec.Activity
	if activity.State == "" {
		activity.State = domain.ActivityIdle
	}
	if activity.LastActivityAt.IsZero() {
		activity.LastActivityAt = rec.CreatedAt
	}
	_, err := q.ExecContext(ctx, `
INSERT INTO sessions (
  org_id, id, project_id, num, issue_id, kind, harness, display_name, activity_state,
  activity_last_at, first_signal_at, is_terminated, branch, workspace_path,
  workspace_repo_path, runtime_handle_id, runtime_launch_id, agent_session_id, prompt,
  preview_url, preview_revision, terminate_on_pr_merge, cleanup_generation, created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9,
  $10, $11, $12, $13, $14,
  $15, $16, $17, $18, $19,
  $20, $21, $22, $23, $24, $25
)`, orgID, rec.ID, rec.ProjectID, num, rec.IssueID, rec.Kind, rec.Harness, rec.DisplayName,
		activity.State, activity.LastActivityAt.UTC(), nullTime(rec.FirstSignalAt), rec.IsTerminated,
		rec.Metadata.Branch, rec.Metadata.WorkspacePath, rec.Metadata.WorkspaceRepoPath,
		rec.Metadata.RuntimeHandleID, rec.Metadata.RuntimeLaunchID, rec.Metadata.AgentSessionID,
		rec.Metadata.Prompt, rec.Metadata.PreviewURL, rec.Metadata.PreviewRevision,
		rec.TerminateOnPRMerge, rec.CleanupGeneration, rec.CreatedAt.UTC(), rec.UpdatedAt.UTC())
	if err != nil {
		return fmt.Errorf("insert session %s: %w", rec.ID, err)
	}
	return nil
}

const sessionUpdateSQL = `
UPDATE sessions SET
  issue_id = $3, kind = $4, harness = $5, display_name = $6, activity_state = $7,
  activity_last_at = $8, first_signal_at = $9, is_terminated = $10, branch = $11,
  workspace_path = $12, workspace_repo_path = $13, runtime_handle_id = $14,
  runtime_launch_id = $15, agent_session_id = $16, prompt = $17, preview_url = $18,
  preview_revision = $19, terminate_on_pr_merge = $20, cleanup_generation = $21, updated_at = $22
WHERE org_id = $1 AND id = $2
`

func sessionUpdateArgs(orgID string, rec domain.SessionRecord) []any {
	activity := rec.Activity
	if activity.State == "" {
		activity.State = domain.ActivityIdle
	}
	if activity.LastActivityAt.IsZero() {
		activity.LastActivityAt = rec.UpdatedAt
	}
	return []any{
		orgID, rec.ID, rec.IssueID, rec.Kind, rec.Harness, rec.DisplayName, activity.State,
		activity.LastActivityAt.UTC(), nullTime(rec.FirstSignalAt), rec.IsTerminated,
		rec.Metadata.Branch, rec.Metadata.WorkspacePath, rec.Metadata.WorkspaceRepoPath,
		rec.Metadata.RuntimeHandleID, rec.Metadata.RuntimeLaunchID, rec.Metadata.AgentSessionID,
		rec.Metadata.Prompt, rec.Metadata.PreviewURL, rec.Metadata.PreviewRevision,
		rec.TerminateOnPRMerge, rec.CleanupGeneration, rec.UpdatedAt.UTC(),
	}
}
