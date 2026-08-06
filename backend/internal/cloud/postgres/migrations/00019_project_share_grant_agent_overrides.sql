-- +goose Up
ALTER TABLE ao_project_share_grants
    ADD COLUMN agent_access_overridden BOOLEAN NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE ao_project_share_grants
    DROP COLUMN IF EXISTS agent_access_overridden;
