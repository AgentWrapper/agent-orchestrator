-- +goose Up
-- +goose StatementBegin
-- Rebuilds notifications to admit the 'main_ci_red' type. Preserve the schema
-- shape established by 0039: session_id has no sessions(id) FK, because
-- model-health (and now main-CI) notifications use deterministic synthetic
-- session IDs and have no backing session row. Keep the model_* types 0039
-- added or this rebuild would silently drop them from the CHECK.
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
            'model_recovered',
            'main_ci_red'
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
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;
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
DELETE FROM notifications
WHERE type = 'main_ci_red';

-- Restore the exact post-0039 shape: no sessions(id) FK, model_* types kept.
CREATE TABLE notifications_old (
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
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;
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
