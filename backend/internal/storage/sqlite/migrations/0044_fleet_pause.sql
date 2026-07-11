-- Fleet pause/resume (GH #161). "Pause is a bit, not config surgery": the
-- pause state is persisted independently of the per-project config JSON blob so
-- that pausing then resuming leaves config byte-identical.
--
--   * projects.paused — a dedicated per-project flag, mutated only by its own
--     UPDATE (never through the config blob, which set-config --clear would
--     wipe). UpsertProject deliberately omits this column so saving config
--     preserves the pause bit.
--   * daemon_settings.fleet_paused — the daemon-global switch. A distinct flag
--     (not "all projects paused") so a project registered while the fleet is
--     paused is still gated: enforcement reads this flag directly. Single-row
--     table (CHECK id = 1) seeded with the unpaused default.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE daemon_settings (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    fleet_paused INTEGER NOT NULL DEFAULT 0
);
-- +goose StatementEnd
-- +goose StatementBegin
INSERT INTO daemon_settings (id, fleet_paused) VALUES (1, 0);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE daemon_settings;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE projects DROP COLUMN paused;
-- +goose StatementEnd
