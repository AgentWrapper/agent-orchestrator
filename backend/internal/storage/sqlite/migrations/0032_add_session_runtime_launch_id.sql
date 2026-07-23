-- +goose Up
-- A launch id fences asynchronous runtime observations. After a supervised
-- agent process is restarted, a delayed hook or probe from its previous
-- generation must not move the current process back to exited.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN runtime_launch_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN runtime_launch_id;
-- +goose StatementEnd
