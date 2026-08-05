-- +goose Up
ALTER TABLE ao_project_share_policies
    DROP COLUMN IF EXISTS sandbox_lifetime_minutes;

-- +goose Down
ALTER TABLE ao_project_share_policies
    ADD COLUMN sandbox_lifetime_minutes INTEGER NOT NULL DEFAULT 120
        CHECK (sandbox_lifetime_minutes > 0);
