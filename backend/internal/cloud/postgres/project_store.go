package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func (s *Store) UpsertProject(ctx context.Context, r domain.ProjectRecord) error {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return err
	}
	config, err := marshalProjectConfig(r.Config)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO projects (org_id, id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (org_id, id) DO UPDATE SET
  path = EXCLUDED.path,
  repo_origin_url = EXCLUDED.repo_origin_url,
  display_name = EXCLUDED.display_name,
  registered_at = EXCLUDED.registered_at,
  archived_at = EXCLUDED.archived_at,
  config = EXCLUDED.config,
  kind = EXCLUDED.kind
`, orgID, r.ID, r.Path, r.RepoOriginURL, r.DisplayName, r.RegisteredAt.UTC(), nullTime(r.ArchivedAt), config, string(r.Kind.WithDefault()))
	if err != nil {
		return fmt.Errorf("upsert project %s: %w", r.ID, err)
	}
	return nil
}

func (s *Store) UpsertWorkspaceProject(ctx context.Context, r domain.ProjectRecord, repos []domain.WorkspaceRepoRecord) error {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	config, err := marshalProjectConfig(r.Config)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO projects (org_id, id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (org_id, id) DO UPDATE SET
  path = EXCLUDED.path,
  repo_origin_url = EXCLUDED.repo_origin_url,
  display_name = EXCLUDED.display_name,
  registered_at = EXCLUDED.registered_at,
  archived_at = EXCLUDED.archived_at,
  config = EXCLUDED.config,
  kind = EXCLUDED.kind
`, orgID, r.ID, r.Path, r.RepoOriginURL, r.DisplayName, r.RegisteredAt.UTC(), nullTime(r.ArchivedAt), config, string(r.Kind.WithDefault())); err != nil {
		return fmt.Errorf("upsert workspace project %s: %w", r.ID, err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_repos WHERE org_id = $1 AND project_id = $2`, orgID, r.ID); err != nil {
		return err
	}
	for _, repo := range repos {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_repos (org_id, project_id, name, relative_path, repo_origin_url, registered_at)
VALUES ($1, $2, $3, $4, $5, $6)
`, orgID, r.ID, repo.Name, repo.RelativePath, repo.RepoOriginURL, repo.RegisteredAt.UTC()); err != nil {
			return fmt.Errorf("upsert workspace repo %s/%s: %w", r.ID, repo.Name, err)
		}
	}
	return tx.Commit()
}

func (s *Store) ImportWorkspaceProject(ctx context.Context, r domain.ProjectRecord, repos []domain.WorkspaceRepoRecord) error {
	return s.UpsertWorkspaceProject(ctx, r, repos)
}

func (s *Store) ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT project_id, name, relative_path, repo_origin_url, registered_at
FROM workspace_repos
WHERE org_id = $1 AND project_id = $2
ORDER BY name
`, orgID, projectID)
	if err != nil {
		return nil, fmt.Errorf("list workspace repos: %w", err)
	}
	defer rows.Close()
	var out []domain.WorkspaceRepoRecord
	for rows.Next() {
		var rec domain.WorkspaceRepoRecord
		if err := rows.Scan(&rec.ProjectID, &rec.Name, &rec.RelativePath, &rec.RepoOriginURL, &rec.RegisteredAt); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return domain.ProjectRecord{}, false, err
	}
	row, err := s.queryProject(ctx, `WHERE org_id = $1 AND id = $2`, orgID, id)
	if noRows(err) {
		return domain.ProjectRecord{}, false, nil
	}
	if err != nil {
		return domain.ProjectRecord{}, false, fmt.Errorf("get project %s: %w", id, err)
	}
	return row, true, nil
}

func (s *Store) FindProjectByPath(ctx context.Context, path string) (domain.ProjectRecord, bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return domain.ProjectRecord{}, false, err
	}
	row, err := s.queryProject(ctx, `WHERE org_id = $1 AND path = $2`, orgID, path)
	if noRows(err) {
		return domain.ProjectRecord{}, false, nil
	}
	if err != nil {
		return domain.ProjectRecord{}, false, fmt.Errorf("find project by path %s: %w", path, err)
	}
	return row, true, nil
}

func (s *Store) ListProjects(ctx context.Context) ([]domain.ProjectRecord, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, projectSelectSQL+`
WHERE org_id = $1 AND archived_at IS NULL
ORDER BY id
`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	var out []domain.ProjectRecord
	for rows.Next() {
		rec, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *Store) UpdateProjectSettings(ctx context.Context, id, displayName string, config domain.ProjectConfig) (bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return false, err
	}
	encoded, err := marshalProjectConfig(config)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `
UPDATE projects
SET display_name = $3, config = $4
WHERE org_id = $1 AND id = $2 AND archived_at IS NULL
`, orgID, id, displayName, encoded)
	if err != nil {
		return false, fmt.Errorf("update project settings: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) CountProjectsIncludingArchived(ctx context.Context) (int, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return 0, err
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM projects WHERE org_id = $1`, orgID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count projects: %w", err)
	}
	return count, nil
}

func (s *Store) ArchiveProject(ctx context.Context, id string, at time.Time) (bool, error) {
	orgID, err := tenancy.OrgIDFromContext(ctx)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE projects SET archived_at = $3 WHERE org_id = $1 AND id = $2 AND archived_at IS NULL`, orgID, id, at.UTC())
	if err != nil {
		return false, fmt.Errorf("archive project: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

const projectSelectSQL = `
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind
FROM projects
`

func (s *Store) queryProject(ctx context.Context, where string, args ...any) (domain.ProjectRecord, error) {
	row := s.db.QueryRowContext(ctx, projectSelectSQL+where, args...)
	return scanProject(row)
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProject(row scanner) (domain.ProjectRecord, error) {
	var rec domain.ProjectRecord
	var archived sql.NullTime
	var config sql.NullString
	if err := row.Scan(&rec.ID, &rec.Path, &rec.RepoOriginURL, &rec.DisplayName, &rec.RegisteredAt, &archived, &config, &rec.Kind); err != nil {
		return domain.ProjectRecord{}, err
	}
	if archived.Valid {
		rec.ArchivedAt = archived.Time
	}
	rec.Config = unmarshalProjectConfig(config)
	rec.Kind = rec.Kind.WithDefault()
	return rec, nil
}
