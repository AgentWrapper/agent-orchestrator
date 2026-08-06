-- +goose Up
ALTER TABLE ao_turns
    ADD COLUMN command_guard_enabled BOOLEAN NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE ao_turns
    DROP COLUMN IF EXISTS command_guard_enabled;
