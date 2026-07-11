-- Admit the duplicate_pr alert (issue #181) into the notifications.type CHECK.
-- Main's 0033 rebuilt this table with a six-value CHECK and 0034 added the
-- head_sha column and folded it into the unread-dedupe index, so the old
-- in-place writable_schema widening no longer matches. Rebuild the table the
-- same way 0033 did, carrying head_sha forward and appending 'duplicate_pr'.
-- +goose Up
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;

CREATE TABLE notifications_next (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (
        type IN (
            'needs_input',
            'ready_to_merge',
            'pr_merged',
            'pr_closed_unmerged',
            'orchestrator_replaced',
            'orchestrator_replacement_capped',
            'duplicate_pr'
        )
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMP NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    changed_paths TEXT NOT NULL DEFAULT '[]',
    head_sha TEXT NOT NULL DEFAULT ''
);

INSERT INTO notifications_next (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
)
SELECT
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM notifications
WHERE type = 'duplicate_pr';

DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;

CREATE TABLE notifications_next (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (
        type IN (
            'needs_input',
            'ready_to_merge',
            'pr_merged',
            'pr_closed_unmerged',
            'orchestrator_replaced',
            'orchestrator_replacement_capped'
        )
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMP NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    changed_paths TEXT NOT NULL DEFAULT '[]',
    head_sha TEXT NOT NULL DEFAULT ''
);

INSERT INTO notifications_next (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
)
SELECT
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
-- +goose StatementEnd
