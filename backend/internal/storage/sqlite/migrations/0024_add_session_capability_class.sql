-- +goose Up
-- capability_class records the control policy applied to each AO session.
-- Existing rows keep an empty value and are interpreted from session kind;
-- every new spawn/restore persists an explicit class.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN capability_class TEXT NOT NULL DEFAULT ''
    CHECK (capability_class IN ('', 'orchestrator', 'ao_worker', 'native_subagent'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN capability_class;
-- +goose StatementEnd
