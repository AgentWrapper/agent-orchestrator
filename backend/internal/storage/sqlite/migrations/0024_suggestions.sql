-- +goose Up
-- +goose StatementBegin
CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('later', 'normal', 'important')),
    status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('backlog', 'in_progress', 'done', 'dismissed')),
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_suggestions_project_status
    ON suggestions(project_id, status, updated_at DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_suggestions_project_status;
DROP TABLE IF EXISTS suggestions;
-- +goose StatementEnd
