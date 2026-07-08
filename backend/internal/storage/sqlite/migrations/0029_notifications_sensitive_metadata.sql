-- +goose Up
-- +goose StatementBegin
ALTER TABLE notifications ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE notifications ADD COLUMN changed_paths TEXT NOT NULL DEFAULT '[]';
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive)
    WHERE status = 'unread';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url)
    WHERE status = 'unread';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE notifications DROP COLUMN changed_paths;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE notifications DROP COLUMN sensitive;
-- +goose StatementEnd
