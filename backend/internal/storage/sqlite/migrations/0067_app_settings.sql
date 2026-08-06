-- +goose Up
-- +goose StatementBegin
-- AO's first daemon-owned user preference.
--
-- It has to live here rather than in the renderer: desktop, mobile, `ao spawn`,
-- and headless spawns all resolve the default session interface, and a
-- localStorage value would look correct in Settings while silently disagreeing
-- with the CLI. One row, one source of truth.
--
-- CHECK (id = 1) makes the singleton structural instead of a convention someone
-- can violate later — there is no way to insert a second settings row.
CREATE TABLE app_settings (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    -- Defaults to 'tui' so an upgrade changes nobody's workflow. Chat is only
    -- ever chosen deliberately.
    default_session_mode TEXT NOT NULL DEFAULT 'tui'
        CHECK (default_session_mode IN ('chat', 'tui')),
    updated_at           TIMESTAMP NOT NULL
);

-- Seed the row at migration time so every read is a plain SELECT and no caller
-- has to handle "settings do not exist yet".
INSERT INTO app_settings (id, default_session_mode, updated_at)
VALUES (1, 'tui', CURRENT_TIMESTAMP);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS app_settings;
-- +goose StatementEnd
