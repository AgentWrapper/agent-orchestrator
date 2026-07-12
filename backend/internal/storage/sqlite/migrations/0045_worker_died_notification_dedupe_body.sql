-- +goose Up
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_worker_died_unfinished_dedupe
ON notifications(session_id, type, body)
WHERE type = 'worker_died_unfinished';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_worker_retry_exhausted_dedupe
ON notifications(session_id, type)
WHERE type = 'worker_retry_exhausted';

-- +goose Down
DROP INDEX IF EXISTS idx_notifications_worker_retry_exhausted_dedupe;
DROP INDEX IF EXISTS idx_notifications_worker_died_unfinished_dedupe;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_worker_terminal_dedupe
ON notifications(session_id, type)
WHERE type IN ('worker_died_unfinished', 'worker_retry_exhausted');
