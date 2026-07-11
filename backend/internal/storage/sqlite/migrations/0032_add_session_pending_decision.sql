-- +goose Up
ALTER TABLE sessions ADD COLUMN pending_decision TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN pending_decision;
