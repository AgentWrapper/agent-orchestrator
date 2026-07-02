-- +goose Up
-- +goose StatementBegin
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'single_repo'
    CHECK (kind IN ('single_repo', 'workspace'));

CREATE TABLE workspace_repos (
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    relative_path   TEXT NOT NULL,
    repo_origin_url TEXT NOT NULL DEFAULT '',
    default_branch  TEXT NOT NULL DEFAULT 'main',
    registered_at   TIMESTAMP NOT NULL,
    PRIMARY KEY (project_id, name),
    UNIQUE (project_id, relative_path)
);

CREATE TABLE session_worktrees (
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    repo_name      TEXT NOT NULL,
    branch         TEXT NOT NULL,
    base_sha       TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    preserved_ref  TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'removed', 'retry_remove', 'unavailable', 'stray_moved')),
    PRIMARY KEY (session_id, repo_name)
);
CREATE INDEX idx_session_worktrees_session ON session_worktrees(session_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE session_worktrees;
DROP TABLE workspace_repos;
-- SQLite cannot drop projects.kind without rebuilding the table. Existing down
-- migrations in this project are best-effort for dev databases; leave the
-- backward-compatible column in place.
-- +goose StatementEnd
