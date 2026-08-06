-- +goose Up
ALTER TABLE ao_projects
    ADD COLUMN share_command_guard_enforced BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE ao_project_share_policies
    ADD COLUMN command_guard_enabled BOOLEAN NOT NULL DEFAULT false;

UPDATE ao_project_share_policies
SET command_guard_enabled = true
WHERE sandbox_type = 'standard';

ALTER TABLE ao_project_share_grant_sessions
    ADD COLUMN command_guard_enabled BOOLEAN;

-- +goose Down
ALTER TABLE ao_project_share_grant_sessions
    DROP COLUMN IF EXISTS command_guard_enabled;

ALTER TABLE ao_project_share_policies
    DROP COLUMN IF EXISTS command_guard_enabled;

ALTER TABLE ao_projects
    DROP COLUMN IF EXISTS share_command_guard_enforced;
