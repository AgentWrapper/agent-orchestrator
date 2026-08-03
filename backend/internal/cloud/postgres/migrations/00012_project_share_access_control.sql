-- +goose Up
ALTER TABLE ao_project_share_links
    ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'anyone'
        CHECK (access_scope IN ('anyone', 'restricted'));

CREATE TABLE ao_project_share_link_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_link_id UUID NOT NULL REFERENCES ao_project_share_links(id) ON DELETE CASCADE,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('email', 'org')),
    email TEXT,
    org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (recipient_type = 'email' AND email IS NOT NULL AND org_id IS NULL)
        OR (recipient_type = 'org' AND org_id IS NOT NULL AND email IS NULL)
    )
);
CREATE UNIQUE INDEX ao_project_share_link_recipients_email_key
    ON ao_project_share_link_recipients(share_link_id, email)
    WHERE recipient_type = 'email';
CREATE UNIQUE INDEX ao_project_share_link_recipients_org_key
    ON ao_project_share_link_recipients(share_link_id, org_id)
    WHERE recipient_type = 'org';

ALTER TABLE ao_project_share_link_recipients ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_project_share_link_recipients;
ALTER TABLE ao_project_share_links
    DROP COLUMN IF EXISTS access_scope;
