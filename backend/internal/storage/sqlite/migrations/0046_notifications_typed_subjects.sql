-- +goose Up
-- +goose StatementBegin
CREATE TABLE notifications_next (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    subject_kind TEXT NOT NULL DEFAULT 'session',
    subject_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('read', 'unread')),
    created_at TIMESTAMP NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    changed_paths TEXT NOT NULL DEFAULT '[]',
    head_sha TEXT NOT NULL DEFAULT ''
);

INSERT INTO notifications_next (
    id, session_id, project_id, pr_url, type, subject_kind, subject_id, title, body, status, created_at, sensitive, changed_paths, head_sha
)
SELECT
    id,
    CASE
        WHEN type IN ('model_unreachable', 'model_recovered', 'main_ci_red') THEN ''
        ELSE session_id
    END,
    project_id,
    pr_url,
    type,
    CASE
        WHEN type IN ('model_unreachable', 'model_recovered') THEN 'model'
        WHEN type = 'main_ci_red' THEN 'project'
        WHEN pr_url != '' THEN 'pr'
        ELSE 'session'
    END,
    CASE
        WHEN type IN ('model_unreachable', 'model_recovered') THEN session_id
        WHEN type = 'main_ci_red' THEN project_id
        WHEN pr_url != '' THEN pr_url
        ELSE session_id
    END,
    title,
    body,
    status,
    created_at,
    sensitive,
    changed_paths,
    head_sha
FROM notifications;

DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;
DROP INDEX IF EXISTS idx_notifications_worker_died_unfinished_dedupe;
DROP INDEX IF EXISTS idx_notifications_worker_retry_exhausted_dedupe;
DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(subject_kind, subject_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
CREATE UNIQUE INDEX idx_notifications_worker_died_unfinished_dedupe
    ON notifications(subject_kind, subject_id, type, body)
    WHERE type = 'worker_died_unfinished';
CREATE UNIQUE INDEX idx_notifications_worker_retry_exhausted_dedupe
    ON notifications(subject_kind, subject_id, type)
    WHERE type = 'worker_retry_exhausted';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM notifications
WHERE type NOT IN (
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
);

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

INSERT INTO notifications_old (
    id, session_id, project_id, pr_url, type, title, body, status, created_at, sensitive, changed_paths, head_sha
)
SELECT
    id,
    CASE
        WHEN session_id != '' THEN session_id
        WHEN subject_kind = 'model' THEN subject_id
        WHEN type = 'main_ci_red' THEN 'main-ci'
        ELSE subject_id
    END,
    project_id,
    pr_url,
    type,
    title,
    body,
    status,
    created_at,
    sensitive,
    changed_paths,
    head_sha
FROM notifications;

DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
DROP INDEX IF EXISTS idx_notifications_status;
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;
DROP INDEX IF EXISTS idx_notifications_worker_died_unfinished_dedupe;
DROP INDEX IF EXISTS idx_notifications_worker_retry_exhausted_dedupe;
DROP TABLE notifications;
ALTER TABLE notifications_old RENAME TO notifications;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
CREATE UNIQUE INDEX idx_notifications_worker_died_unfinished_dedupe
    ON notifications(session_id, type, body)
    WHERE type = 'worker_died_unfinished';
CREATE UNIQUE INDEX idx_notifications_worker_retry_exhausted_dedupe
    ON notifications(session_id, type)
    WHERE type = 'worker_retry_exhausted';
-- +goose StatementEnd
