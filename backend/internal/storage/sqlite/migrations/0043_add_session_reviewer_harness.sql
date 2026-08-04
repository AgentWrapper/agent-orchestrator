-- +goose Up
ALTER TABLE sessions ADD COLUMN reviewer_harness TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN reviewer_harness;
