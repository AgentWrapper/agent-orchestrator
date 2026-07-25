-- +goose Up
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_status;

CREATE INDEX idx_notifications_status_history
    ON notifications(status, created_at DESC, id DESC);

CREATE INDEX idx_notifications_history
    ON notifications(created_at DESC, id DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_history;
DROP INDEX IF EXISTS idx_notifications_status_history;

CREATE INDEX idx_notifications_status
    ON notifications(status, created_at DESC);
-- +goose StatementEnd
