-- +goose Up
CREATE TABLE ao_org_provider_settings (
    org_id UUID PRIMARY KEY REFERENCES ao_organizations(id) ON DELETE CASCADE,
    agent_credentials_mode TEXT NOT NULL DEFAULT 'custom'
        CHECK (agent_credentials_mode IN ('custom', 'personal_default')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing orgs keep their current explicit behavior. Newly created team orgs
-- opt into personal defaults in the application layer.
INSERT INTO ao_org_provider_settings (org_id, agent_credentials_mode)
SELECT id, 'custom'
FROM ao_organizations
ON CONFLICT (org_id) DO NOTHING;

ALTER TABLE ao_projects
    ADD CONSTRAINT ao_projects_org_id_key UNIQUE (org_id, id);
ALTER TABLE ao_sessions
    ADD CONSTRAINT ao_sessions_org_project_id_key UNIQUE (org_id, project_id, id);

CREATE TABLE ao_project_share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    session_id UUID REFERENCES ao_sessions(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    role TEXT NOT NULL CHECK (role IN ('viewer', 'admin', 'owner')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_project_share_links_session_project_fk
        FOREIGN KEY (org_id, project_id, session_id)
        REFERENCES ao_sessions(org_id, project_id, id)
        ON DELETE CASCADE,
    CONSTRAINT ao_project_share_links_project_org_fk
        FOREIGN KEY (org_id, project_id)
        REFERENCES ao_projects(org_id, id)
        ON DELETE CASCADE
);
CREATE INDEX ao_project_share_links_project_idx
    ON ao_project_share_links(org_id, project_id, created_at DESC)
    WHERE status = 'active';

CREATE TABLE ao_project_share_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_link_id UUID NOT NULL REFERENCES ao_project_share_links(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    session_id UUID REFERENCES ao_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    shared_by_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'admin', 'owner')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_project_share_grants_project_org_fk
        FOREIGN KEY (org_id, project_id)
        REFERENCES ao_projects(org_id, id)
        ON DELETE CASCADE,
    CONSTRAINT ao_project_share_grants_session_project_fk
        FOREIGN KEY (org_id, project_id, session_id)
        REFERENCES ao_sessions(org_id, project_id, id)
        ON DELETE CASCADE
);
CREATE UNIQUE INDEX ao_project_share_grants_one_active
    ON ao_project_share_grants(user_id, org_id, project_id)
    WHERE status = 'active';
CREATE INDEX ao_project_share_grants_user_idx
    ON ao_project_share_grants(user_id, status, redeemed_at DESC);

ALTER TABLE ao_org_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_project_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_project_share_grants ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_project_share_grants;
DROP TABLE IF EXISTS ao_project_share_links;
ALTER TABLE ao_sessions
    DROP CONSTRAINT IF EXISTS ao_sessions_org_project_id_key;
ALTER TABLE ao_projects
    DROP CONSTRAINT IF EXISTS ao_projects_org_id_key;
DROP TABLE IF EXISTS ao_org_provider_settings;
