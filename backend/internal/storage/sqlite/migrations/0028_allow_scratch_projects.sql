-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
PRAGMA foreign_keys=OFF;

CREATE TABLE projects_new (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL,
    repo_origin_url TEXT NOT NULL DEFAULT '',
    display_name    TEXT NOT NULL DEFAULT '',
    registered_at   TIMESTAMP NOT NULL,
    archived_at     TIMESTAMP,
    config          TEXT,
    kind            TEXT NOT NULL DEFAULT 'single_repo'
        CHECK (kind IN ('single_repo', 'workspace', 'scratch'))
);

INSERT INTO projects_new (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind)
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- SQLite cannot narrow this CHECK safely once scratch rows may exist. Keep the
-- widened constraint in place, matching the existing best-effort project-kind
-- down migration style.
-- +goose StatementEnd
