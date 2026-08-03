-- Persist the reviewer's native agent session id so restored reviewer terminals
-- can resume the original conversation instead of starting a fresh shell.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review ADD COLUMN agent_session_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE review DROP COLUMN agent_session_id;
-- +goose StatementEnd
