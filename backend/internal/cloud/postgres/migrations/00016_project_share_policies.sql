-- +goose Up
CREATE TABLE ao_project_share_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_project_share_policies_project_org_fk
        FOREIGN KEY (org_id, project_id)
        REFERENCES ao_projects(org_id, id)
        ON DELETE CASCADE,
    CONSTRAINT ao_project_share_policies_name_not_blank
        CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX ao_project_share_policies_active_name_unique
    ON ao_project_share_policies(org_id, project_id, lower(name))
    WHERE status = 'active';

CREATE TABLE ao_project_share_policy_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL REFERENCES ao_project_share_policies(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_project_share_policy_sessions_session_project_fk
        FOREIGN KEY (org_id, project_id, session_id)
        REFERENCES ao_sessions(org_id, project_id, id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX ao_project_share_policy_sessions_unique
    ON ao_project_share_policy_sessions(policy_id, session_id);

ALTER TABLE ao_project_share_links
    ADD COLUMN policy_id UUID REFERENCES ao_project_share_policies(id) ON DELETE SET NULL;

ALTER TABLE ao_project_share_grants
    ADD COLUMN policy_id UUID REFERENCES ao_project_share_policies(id) ON DELETE SET NULL;

CREATE INDEX ao_project_share_links_policy_idx
    ON ao_project_share_links(policy_id)
    WHERE policy_id IS NOT NULL;

CREATE INDEX ao_project_share_grants_policy_idx
    ON ao_project_share_grants(policy_id)
    WHERE policy_id IS NOT NULL;

ALTER TABLE ao_project_share_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_project_share_policy_sessions ENABLE ROW LEVEL SECURITY;

-- +goose Down
ALTER TABLE ao_project_share_grants DROP COLUMN IF EXISTS policy_id;
ALTER TABLE ao_project_share_links DROP COLUMN IF EXISTS policy_id;
DROP TABLE IF EXISTS ao_project_share_policy_sessions;
DROP TABLE IF EXISTS ao_project_share_policies;
