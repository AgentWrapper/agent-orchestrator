-- +goose Up
-- +goose StatementBegin
-- Seed the built-in Scratch pseudo-project so project-less "scratch" sessions
-- satisfy the sessions.project_id foreign key (and every other project-scoped
-- FK). kind stays 'single_repo': the projects.kind CHECK predates the scratch
-- kind and cannot be altered without rebuilding the table, so the service
-- layer always presents id 'scratch' as kind 'scratch' instead.
INSERT OR IGNORE INTO projects (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind)
VALUES ('scratch', '', '', 'Scratch', datetime('now'), NULL, NULL, 'single_repo');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM projects WHERE id = 'scratch'
    AND NOT EXISTS (SELECT 1 FROM sessions WHERE project_id = 'scratch');
-- +goose StatementEnd
