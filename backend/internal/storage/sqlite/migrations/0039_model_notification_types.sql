-- +goose Up
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;

-- Model-health notifications use deterministic synthetic session IDs so they can
-- share the notification rail without creating fake session rows. Keep
-- session_id NOT NULL for API compatibility, but do not restore the historical
-- sessions(id) FK unless model notifications get their own nullable target.
CREATE TABLE notifications_new (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
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
            'worker_retry_exhausted',
            'model_unreachable',
            'model_recovered'
        )
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMP NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    head_sha TEXT NOT NULL DEFAULT '',
    changed_paths TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO notifications_new (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, head_sha, changed_paths
)
SELECT id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, head_sha, changed_paths
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';

CREATE UNIQUE INDEX idx_notifications_worker_terminal_dedupe
    ON notifications(session_id, type)
    WHERE type IN ('worker_died_unfinished', 'worker_retry_exhausted');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;

DELETE FROM notifications WHERE type IN ('model_unreachable', 'model_recovered');

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
    head_sha TEXT NOT NULL DEFAULT '',
    changed_paths TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO notifications_old (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, head_sha, changed_paths
)
SELECT id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, head_sha, changed_paths
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_old RENAME TO notifications;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';

CREATE UNIQUE INDEX idx_notifications_worker_terminal_dedupe
    ON notifications(session_id, type)
    WHERE type IN ('worker_died_unfinished', 'worker_retry_exhausted');
-- +goose StatementEnd
