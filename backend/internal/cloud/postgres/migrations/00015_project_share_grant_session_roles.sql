-- +goose Up
CREATE TABLE ao_project_share_grant_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grant_id UUID NOT NULL REFERENCES ao_project_share_grants(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ao_project_share_grant_sessions_session_project_fk
        FOREIGN KEY (org_id, project_id, session_id)
        REFERENCES ao_sessions(org_id, project_id, id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX ao_project_share_grant_sessions_unique
    ON ao_project_share_grant_sessions(grant_id, session_id);
CREATE INDEX ao_project_share_grant_sessions_grant_idx
    ON ao_project_share_grant_sessions(grant_id);

ALTER TABLE ao_project_share_grant_sessions ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_project_share_grant_sessions;
