-- +goose Up
-- +goose StatementBegin

-- Notifications now carry two independent axes instead of one read flag:
--   status      — has the user SEEN it (unread = unseen). Cleared wholesale the
--                 moment the notification panel is opened.
--   resolved_at — is the underlying issue still OPEN. Set by lifecycle when the
--                 session receives its input or the PR stops being ready to
--                 merge. Never set by a user action.
ALTER TABLE notifications ADD COLUMN resolved_at TIMESTAMP;

-- Rows acknowledged before this migration have no live resolution tracking
-- behind them. Treat the acknowledgement as the resolution rather than
-- resurrecting three-day-old rows into the unresolved section.
UPDATE notifications SET resolved_at = created_at WHERE status = 'read';

DROP INDEX IF EXISTS idx_notifications_unread_dedupe;

-- One OPEN row per (session, type, pr), where open means unseen OR unresolved.
-- Keying dedupe on unread alone would let a seen-but-still-unresolved
-- notification be duplicated by the next observation of the same fact.
CREATE UNIQUE INDEX idx_notifications_open_dedupe
    ON notifications(session_id, type, pr_url)
    WHERE status = 'unread' OR resolved_at IS NULL;

CREATE INDEX idx_notifications_unresolved
    ON notifications(resolved_at, created_at DESC, id DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_unresolved;
DROP INDEX IF EXISTS idx_notifications_open_dedupe;

ALTER TABLE notifications DROP COLUMN resolved_at;

CREATE UNIQUE INDEX idx_notifications_unread_dedupe
    ON notifications(session_id, type, pr_url)
    WHERE status = 'unread';
-- +goose StatementEnd
