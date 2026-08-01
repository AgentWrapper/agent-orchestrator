-- +goose Up
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN diff_base_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN diff_base_ref TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN diff_base_ref;
ALTER TABLE sessions DROP COLUMN diff_base_sha;
-- +goose StatementEnd
