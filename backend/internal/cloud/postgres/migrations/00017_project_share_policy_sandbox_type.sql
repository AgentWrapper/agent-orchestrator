-- +goose Up
ALTER TABLE ao_project_share_policies
    ADD COLUMN sandbox_type TEXT NOT NULL DEFAULT 'standard'
        CHECK (sandbox_type IN ('read_only', 'standard', 'trusted')),
    ADD COLUMN sandbox_lifetime_minutes INTEGER NOT NULL DEFAULT 120
        CHECK (sandbox_lifetime_minutes > 0);

-- +goose Down
ALTER TABLE ao_project_share_policies
    DROP COLUMN IF EXISTS sandbox_lifetime_minutes,
    DROP COLUMN IF EXISTS sandbox_type;
