-- Summary: add head_sha to notifications so a PR-derived notification carries
-- the commit it was derived from, and fold it into the unread-dedupe index.
-- A new push (new head) is a real state change that must re-notify even when a
-- prior notification for the same (session, type, pr, sensitive) tuple is still
-- unread — without head_sha in the key the older unread row would swallow it
-- (issue #190 criterion #1: the signature includes the head SHA).
-- +goose Up
-- +goose StatementBegin
ALTER TABLE notifications ADD COLUMN head_sha TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive, head_sha)
    WHERE status = 'unread';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unread_dedupe;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url, sensitive)
    WHERE status = 'unread';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE notifications DROP COLUMN head_sha;
-- +goose StatementEnd
