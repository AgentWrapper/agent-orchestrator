-- +goose Up
-- runtime_token identifies the current launched runtime generation. Agent hooks
-- echo it via AO_RUNTIME_TOKEN so lifecycle can ignore late exit callbacks from
-- a retired same-harness runtime after an agent/model switch.
ALTER TABLE sessions ADD COLUMN runtime_token TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN runtime_token;
