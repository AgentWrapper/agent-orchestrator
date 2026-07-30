-- +goose Up
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN native_resume_ready BOOLEAN NOT NULL DEFAULT FALSE;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN native_resume_ready;
-- +goose StatementEnd
