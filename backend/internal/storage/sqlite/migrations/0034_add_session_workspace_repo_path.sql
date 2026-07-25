-- +goose Up
-- WorkspaceRepoPath is an operational teardown fact. Persisting the source
-- repository at spawn time lets cleanup remove an existing worktree even after
-- its project has been archived or unregistered.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN workspace_repo_path TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN workspace_repo_path;
-- +goose StatementEnd
