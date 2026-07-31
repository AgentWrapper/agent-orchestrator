-- +goose Up
-- +goose StatementBegin
-- Global (not per-project) app settings as a small key/value table. One row per
-- setting. The daemon reads these at boot regardless of who launched it (the
-- Electron supervisor or `ao start`), which is why the flag lives here rather
-- than in Electron userData. First consumer: "pipelines.enabled" (spec §4b T12).
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE app_settings;
-- +goose StatementEnd
