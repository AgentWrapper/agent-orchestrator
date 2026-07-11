-- +goose Up
-- +goose StatementBegin
CREATE TABLE notifications_new (
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
            'duplicate_pr',
            'worker_died_unfinished',
            'worker_retry_exhausted'
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

INSERT INTO notifications_new (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
)
SELECT
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
FROM notifications;

DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM notifications
WHERE type IN ('worker_died_unfinished', 'worker_retry_exhausted');

CREATE TABLE notifications_old (
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

INSERT INTO notifications_old (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
)
SELECT
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
FROM notifications;

DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;
DROP TABLE notifications;
ALTER TABLE notifications_old RENAME TO notifications;
CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
-- +goose StatementEnd
