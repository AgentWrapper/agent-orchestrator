-- +goose Up
CREATE TABLE ao_github_install_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    initiating_user_id UUID NOT NULL,
    state_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    pending_github_installation_id BIGINT CHECK (pending_github_installation_id > 0),
    pending_github_account_id BIGINT CHECK (pending_github_account_id > 0),
    pending_account_login TEXT,
    pending_account_type TEXT,
    pending_repository_selection TEXT
        CHECK (pending_repository_selection IN ('all', 'selected')),
    pending_repository_count INTEGER CHECK (pending_repository_count >= 0),
    pending_recorded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_github_install_attempts_org_user_fk
        FOREIGN KEY (org_id, initiating_user_id)
        REFERENCES ao_org_memberships(org_id, user_id)
        ON DELETE CASCADE,
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CHECK (
        (
            pending_github_installation_id IS NULL
            AND pending_github_account_id IS NULL
            AND pending_account_login IS NULL
            AND pending_account_type IS NULL
            AND pending_repository_selection IS NULL
            AND pending_repository_count IS NULL
            AND pending_recorded_at IS NULL
        )
        OR
        (
            pending_github_installation_id IS NOT NULL
            AND pending_github_account_id IS NOT NULL
            AND pending_account_login IS NOT NULL
            AND pending_account_login <> ''
            AND pending_account_type IS NOT NULL
            AND pending_account_type <> ''
            AND pending_repository_selection IS NOT NULL
            AND pending_repository_count IS NOT NULL
            AND pending_recorded_at IS NOT NULL
        )
    )
);
CREATE INDEX ao_github_install_attempts_org_created_idx
    ON ao_github_install_attempts(org_id, created_at DESC);

CREATE TABLE ao_github_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    github_installation_id BIGINT NOT NULL UNIQUE CHECK (github_installation_id > 0),
    github_account_id BIGINT NOT NULL CHECK (github_account_id > 0),
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'disconnected', 'deleted')),
    repository_selection TEXT NOT NULL
        CHECK (repository_selection IN ('all', 'selected')),
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    events TEXT[] NOT NULL DEFAULT '{}',
    installed_by_user_id UUID NOT NULL,
    suspended_at TIMESTAMPTZ,
    disconnected_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_github_installations_org_user_fk
        FOREIGN KEY (org_id, installed_by_user_id)
        REFERENCES ao_org_memberships(org_id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT ao_github_installations_org_id_key UNIQUE (org_id, id),
    CHECK (status <> 'suspended' OR suspended_at IS NOT NULL),
    CHECK (status <> 'disconnected' OR disconnected_at IS NOT NULL),
    CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
CREATE INDEX ao_github_installations_org_status_idx
    ON ao_github_installations(org_id, status, created_at);

CREATE TABLE ao_github_repositories (
    github_repository_id BIGINT PRIMARY KEY CHECK (github_repository_id > 0),
    github_owner_account_id BIGINT NOT NULL CHECK (github_owner_account_id > 0),
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    html_url TEXT NOT NULL,
    clone_url TEXT NOT NULL,
    ssh_url TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT 'main',
    visibility TEXT NOT NULL DEFAULT '',
    is_private BOOLEAN NOT NULL DEFAULT false,
    is_archived BOOLEAN NOT NULL DEFAULT false,
    is_disabled BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    github_updated_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ao_github_repository_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    installation_id UUID NOT NULL,
    github_repository_id BIGINT NOT NULL
        REFERENCES ao_github_repositories(github_repository_id) ON DELETE RESTRICT,
    repository_selection TEXT NOT NULL
        CHECK (repository_selection IN ('all', 'selected')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ao_github_repository_grants_org_installation_fk
        FOREIGN KEY (org_id, installation_id)
        REFERENCES ao_github_installations(org_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT ao_github_repository_grants_org_repository_id_key
        UNIQUE (org_id, github_repository_id, id),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX ao_github_repository_grants_one_active
    ON ao_github_repository_grants(org_id, github_repository_id)
    WHERE revoked_at IS NULL;
CREATE INDEX ao_github_repository_grants_installation_active_idx
    ON ao_github_repository_grants(org_id, installation_id, github_repository_id)
    WHERE revoked_at IS NULL;

ALTER TABLE ao_projects
    ADD COLUMN github_repository_id BIGINT,
    ADD COLUMN github_repository_grant_id UUID,
    ADD CONSTRAINT ao_projects_github_link_complete
        CHECK (
            (github_repository_id IS NULL AND github_repository_grant_id IS NULL)
            OR
            (github_repository_id IS NOT NULL AND github_repository_grant_id IS NOT NULL)
        ),
    ADD CONSTRAINT ao_projects_github_repository_fk
        FOREIGN KEY (github_repository_id)
        REFERENCES ao_github_repositories(github_repository_id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT ao_projects_org_github_grant_fk
        FOREIGN KEY (org_id, github_repository_id, github_repository_grant_id)
        REFERENCES ao_github_repository_grants(org_id, github_repository_id, id)
        ON DELETE RESTRICT;
CREATE INDEX ao_projects_org_github_repository_idx
    ON ao_projects(org_id, github_repository_id)
    WHERE github_repository_id IS NOT NULL;

CREATE TABLE ao_github_webhook_deliveries (
    github_delivery_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    github_installation_id BIGINT CHECK (github_installation_id > 0),
    github_repository_id BIGINT CHECK (github_repository_id > 0),
    payload BYTEA NOT NULL,
    payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'processed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processing_started_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    last_error_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (status = 'processed' AND processed_at IS NOT NULL)
        OR status <> 'processed'
    ),
    CHECK (
        (last_error = '' AND last_error_at IS NULL)
        OR (last_error <> '' AND last_error_at IS NOT NULL)
    )
);
CREATE INDEX ao_github_webhook_deliveries_ready_idx
    ON ao_github_webhook_deliveries(status, next_attempt_at, received_at)
    WHERE status IN ('pending', 'retry');
CREATE INDEX ao_github_webhook_deliveries_installation_idx
    ON ao_github_webhook_deliveries(github_installation_id, received_at DESC)
    WHERE github_installation_id IS NOT NULL;

ALTER TABLE ao_github_install_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_github_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_github_repository_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_github_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_github_webhook_deliveries;
DROP INDEX IF EXISTS ao_projects_org_github_repository_idx;
ALTER TABLE ao_projects
    DROP CONSTRAINT IF EXISTS ao_projects_org_github_grant_fk,
    DROP CONSTRAINT IF EXISTS ao_projects_github_repository_fk,
    DROP CONSTRAINT IF EXISTS ao_projects_github_link_complete,
    DROP COLUMN IF EXISTS github_repository_grant_id,
    DROP COLUMN IF EXISTS github_repository_id;
DROP TABLE IF EXISTS ao_github_repository_grants;
DROP TABLE IF EXISTS ao_github_repositories;
DROP TABLE IF EXISTS ao_github_installations;
DROP TABLE IF EXISTS ao_github_install_attempts;
