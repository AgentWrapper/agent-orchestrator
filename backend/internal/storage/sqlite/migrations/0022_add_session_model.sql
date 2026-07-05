-- +goose Up
-- model preserves the per-session model override supplied at spawn so restore
-- can keep that one session pinned without freezing project/role defaults.
ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN model;
