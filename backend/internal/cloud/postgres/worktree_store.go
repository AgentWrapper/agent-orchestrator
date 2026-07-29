package postgres

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func (s *Store) UpsertSessionWorktree(ctx context.Context, row domain.SessionWorktreeRecord) error {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO session_worktrees (org_id, session_id, repo_name, branch, base_sha, worktree_path, preserved_ref, state)
VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE(NULLIF($8, ''), 'active'))
ON CONFLICT (org_id, session_id, repo_name) DO UPDATE SET
  branch = EXCLUDED.branch,
  base_sha = EXCLUDED.base_sha,
  worktree_path = EXCLUDED.worktree_path,
  preserved_ref = EXCLUDED.preserved_ref,
  state = EXCLUDED.state
`, orgID, row.SessionID, row.RepoName, row.Branch, row.BaseSHA, row.WorktreePath, row.PreservedRef, row.State)
	if err != nil {
		return fmt.Errorf("upsert session worktree: %w", err)
	}
	return nil
}

func (s *Store) GetSessionWorktree(ctx context.Context, sessionID domain.SessionID, repoName string) (domain.SessionWorktreeRecord, bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return domain.SessionWorktreeRecord{}, false, err
	}
	row := s.db.QueryRowContext(ctx, `
SELECT session_id, repo_name, branch, base_sha, worktree_path, preserved_ref, state
FROM session_worktrees
WHERE org_id = $1 AND session_id = $2 AND repo_name = $3
`, orgID, sessionID, repoName)
	rec, err := scanWorktree(row)
	if noRows(err) {
		return domain.SessionWorktreeRecord{}, false, nil
	}
	return rec, err == nil, err
}

func (s *Store) ListSessionWorktrees(ctx context.Context, sessionID domain.SessionID) ([]domain.SessionWorktreeRecord, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT session_id, repo_name, branch, base_sha, worktree_path, preserved_ref, state
FROM session_worktrees
WHERE org_id = $1 AND session_id = $2
ORDER BY repo_name
`, orgID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.SessionWorktreeRecord
	for rows.Next() {
		rec, err := scanWorktree(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSessionWorktrees(ctx context.Context, sessionID domain.SessionID) error {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM session_worktrees WHERE org_id = $1 AND session_id = $2`, orgID, sessionID)
	return err
}

func scanWorktree(row scanner) (domain.SessionWorktreeRecord, error) {
	var rec domain.SessionWorktreeRecord
	err := row.Scan(&rec.SessionID, &rec.RepoName, &rec.Branch, &rec.BaseSHA, &rec.WorktreePath, &rec.PreservedRef, &rec.State)
	return rec, err
}
