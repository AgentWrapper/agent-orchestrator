-- +goose Up
-- model is the agent model this session launched with, captured at spawn time
-- (from `ao spawn --model` or the resolved project/role worker.agentConfig.model).
-- It is durable so a daemon restart restores the session on the SAME model
-- rather than re-resolving from project config, which may have since changed.
-- Defaulting to '' keeps existing rows valid without backfill; '' means "use the
-- resolved project/role config model" on restore (unchanged legacy behaviour).
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN model;
-- +goose StatementEnd
