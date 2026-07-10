-- +goose Up
-- launched_harnesses records every agent harness that has actually launched for
-- a session, comma-separated. Agent switching reads it to decide resume vs fresh
-- launch: a harness already in the set has a native session on disk (e.g. Claude
-- Code pins a deterministic --session-id), so relaunching it fresh would collide
-- ("session id already in use") — it must resume instead. Durable so the choice
-- survives a daemon restart (the agent's on-disk session does too). Defaulting to
-- '' keeps existing rows valid without backfill. Not a CDC-relevant field, so the
-- sessions_cdc_update trigger is left unchanged.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN launched_harnesses TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN launched_harnesses;
-- +goose StatementEnd
