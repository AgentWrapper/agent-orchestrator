-- +goose Up
-- +goose StatementBegin
-- session_id scopes a shell terminal to the agent session it was opened from,
-- so a session's shells appear only in that session's tab strip rather than
-- being shared across every session in the project. It is nullable on purpose:
-- a shell opened outside any session (from the board or the standalone
-- /terminals screen) has no session and lives only on that screen.
--
-- ON DELETE CASCADE ties a session's shells to its lifetime: deleting the
-- session forgets its shell rows too, mirroring the project_id behaviour.
ALTER TABLE shell_terminals
    ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE shell_terminals DROP COLUMN session_id;
-- +goose StatementEnd
