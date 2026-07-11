-- +goose Up
-- +goose StatementBegin

ALTER TABLE sessions ADD COLUMN terminal_failure_reason TEXT NOT NULL DEFAULT '';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE sessions DROP COLUMN terminal_failure_reason;

-- +goose StatementEnd
