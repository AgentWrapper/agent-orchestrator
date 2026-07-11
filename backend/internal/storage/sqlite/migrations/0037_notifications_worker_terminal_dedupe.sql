-- +goose Up
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_worker_terminal_dedupe
ON notifications(session_id, type)
WHERE type IN ('worker_died_unfinished', 'worker_retry_exhausted');

-- +goose Down
DROP INDEX IF EXISTS idx_notifications_worker_terminal_dedupe;
