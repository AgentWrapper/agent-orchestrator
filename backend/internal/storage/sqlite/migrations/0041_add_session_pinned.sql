-- +goose Up
ALTER TABLE sessions ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pinned_at DATETIME;

-- +goose Down
ALTER TABLE sessions DROP COLUMN is_pinned;
ALTER TABLE sessions DROP COLUMN pinned_at;
