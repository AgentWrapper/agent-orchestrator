-- +goose Up
CREATE TABLE ao_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_provider TEXT NOT NULL DEFAULT 'local',
    external_user_id TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auth_provider, external_user_id)
);

CREATE TABLE ao_organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_provider TEXT NOT NULL DEFAULT 'local',
    external_org_id TEXT,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'team', 'enterprise')),
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (slug),
    UNIQUE (auth_provider, external_org_id)
);

CREATE TABLE ao_org_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    external_membership_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, user_id)
);

CREATE TABLE ao_org_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL DEFAULT '',
    invited_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    invited_by_user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    token_hash BYTEA UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
    accepted_at TIMESTAMPTZ,
    declined_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ao_org_invitations_one_pending_email
    ON ao_org_invitations(org_id, lower(email))
    WHERE status = 'pending';

ALTER TABLE ao_accounts DROP CONSTRAINT IF EXISTS ao_accounts_owner_user_id_key;
CREATE INDEX ao_accounts_owner_user_id_idx ON ao_accounts(owner_user_id);

INSERT INTO ao_users (id, auth_provider, external_user_id, display_name, created_at, updated_at)
SELECT owner_user_id, 'local', owner_user_id::text, display_name, created_at, updated_at
FROM ao_accounts
ON CONFLICT (id) DO NOTHING;

INSERT INTO ao_organizations (
    id, auth_provider, external_org_id, slug, display_name, kind, plan, status,
    created_by_user_id, created_at, updated_at
)
SELECT
    id,
    'local',
    id::text,
    'personal-' || replace(id::text, '-', ''),
    CASE WHEN display_name = '' THEN 'Personal workspace' ELSE display_name END,
    'personal',
    'free',
    'active',
    owner_user_id,
    created_at,
    updated_at
FROM ao_accounts
ON CONFLICT (id) DO NOTHING;

INSERT INTO ao_org_memberships (org_id, user_id, role, status, created_at, updated_at)
SELECT id, owner_user_id, 'owner', 'active', created_at, updated_at
FROM ao_accounts
ON CONFLICT (org_id, user_id) DO NOTHING;

ALTER TABLE ao_projects ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_projects SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_projects ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_projects_org_idx ON ao_projects(org_id, created_at);
CREATE UNIQUE INDEX ao_projects_org_repository_url_key ON ao_projects(org_id, repository_url);

ALTER TABLE ao_sessions ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_sessions SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_sessions ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_sessions_org_project_idx ON ao_sessions(org_id, project_id, updated_at DESC);

ALTER TABLE ao_commands ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_commands SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_commands ALTER COLUMN org_id SET NOT NULL;
CREATE UNIQUE INDEX ao_commands_org_idempotency_key ON ao_commands(org_id, idempotency_key);

ALTER TABLE ao_events ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_events SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_events ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_events_org_replay_idx ON ao_events(org_id, session_id, sequence);

ALTER TABLE ao_turns ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_turns SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_turns ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_turns_org_session_created_idx ON ao_turns(org_id, session_id, created_at DESC);

ALTER TABLE ao_sandboxes ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_sandboxes SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_sandboxes ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_sandboxes_org_state_idx ON ao_sandboxes(org_id, desired_state, observed_state);

ALTER TABLE ao_provider_connections ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_provider_connections SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_provider_connections ALTER COLUMN org_id SET NOT NULL;
CREATE UNIQUE INDEX ao_provider_connections_org_provider_label_key ON ao_provider_connections(org_id, provider, label);

ALTER TABLE ao_worker_connections ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_worker_connections SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_worker_connections ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_worker_connections_org_session_idx ON ao_worker_connections(org_id, session_id);

ALTER TABLE ao_access_tickets ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_access_tickets SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_access_tickets ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_access_tickets_org_session_idx ON ao_access_tickets(org_id, session_id, purpose);

ALTER TABLE ao_audit_events ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_audit_events SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_audit_events ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_audit_events_org_created_idx ON ao_audit_events(org_id, created_at DESC);

ALTER TABLE ao_pull_requests ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_pull_requests SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_pull_requests ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_pull_requests_org_session_idx ON ao_pull_requests(org_id, session_id, updated_at DESC);
CREATE UNIQUE INDEX ao_pull_requests_org_repository_number_key ON ao_pull_requests(org_id, provider, repository, number);

ALTER TABLE ao_pr_checks ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_pr_checks checks
SET org_id = pr.org_id
FROM ao_pull_requests pr
WHERE checks.pull_request_id = pr.id AND checks.org_id IS NULL;
ALTER TABLE ao_pr_checks ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_pr_checks_org_pull_request_idx ON ao_pr_checks(org_id, pull_request_id);

ALTER TABLE ao_issues ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_issues SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_issues ALTER COLUMN org_id SET NOT NULL;
CREATE UNIQUE INDEX ao_issues_org_provider_repository_number_key ON ao_issues(org_id, provider, repository, number);

ALTER TABLE ao_session_issue_links ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_session_issue_links link
SET org_id = session.org_id
FROM ao_sessions session
WHERE link.session_id = session.id AND link.org_id IS NULL;
ALTER TABLE ao_session_issue_links ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_session_issue_links_org_idx ON ao_session_issue_links(org_id, issue_id);

ALTER TABLE ao_pr_claims ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_pr_claims SET org_id = account_id WHERE org_id IS NULL;
ALTER TABLE ao_pr_claims ALTER COLUMN org_id SET NOT NULL;
CREATE UNIQUE INDEX ao_pr_claims_one_active_org_owner ON ao_pr_claims(org_id, provider, repository, number) WHERE released_at IS NULL;

ALTER TABLE ao_pr_review_threads ADD COLUMN org_id UUID REFERENCES ao_organizations(id) ON DELETE CASCADE;
UPDATE ao_pr_review_threads threads
SET org_id = pr.org_id
FROM ao_pull_requests pr
WHERE threads.pull_request_id = pr.id AND threads.org_id IS NULL;
ALTER TABLE ao_pr_review_threads ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX ao_pr_review_threads_org_pull_request_idx ON ao_pr_review_threads(org_id, pull_request_id);

ALTER TABLE ao_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_org_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_org_invitations ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP INDEX IF EXISTS ao_accounts_owner_user_id_idx;
ALTER TABLE ao_accounts ADD CONSTRAINT ao_accounts_owner_user_id_key UNIQUE (owner_user_id);
ALTER TABLE ao_pr_review_threads DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_pr_claims DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_session_issue_links DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_issues DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_pr_checks DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_pull_requests DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_audit_events DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_access_tickets DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_worker_connections DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_provider_connections DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_sandboxes DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_turns DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_events DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_commands DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_sessions DROP COLUMN IF EXISTS org_id;
ALTER TABLE ao_projects DROP COLUMN IF EXISTS org_id;
DROP TABLE IF EXISTS ao_org_invitations;
DROP TABLE IF EXISTS ao_org_memberships;
DROP TABLE IF EXISTS ao_organizations;
DROP TABLE IF EXISTS ao_users;
