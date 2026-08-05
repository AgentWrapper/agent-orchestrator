-- +goose Up
CREATE TABLE ao_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'github',
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, provider, repository, number)
);
CREATE TABLE ao_session_issue_links (
    session_id UUID PRIMARY KEY REFERENCES ao_sessions(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES ao_issues(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ao_pr_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'github',
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    url TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ,
    UNIQUE (session_id, provider, repository, number)
);
CREATE UNIQUE INDEX ao_pr_claims_one_active_owner ON ao_pr_claims(account_id, provider, repository, number) WHERE released_at IS NULL;
CREATE TABLE ao_pr_review_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    pull_request_id UUID NOT NULL REFERENCES ao_pull_requests(id) ON DELETE CASCADE,
    provider_thread_id TEXT NOT NULL,
    is_resolved BOOLEAN NOT NULL DEFAULT false,
    is_outdated BOOLEAN NOT NULL DEFAULT false,
    path TEXT NOT NULL DEFAULT '',
    line INTEGER,
    body TEXT NOT NULL DEFAULT '',
    author_login TEXT NOT NULL DEFAULT '',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pull_request_id, provider_thread_id)
);
ALTER TABLE ao_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_session_issue_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pr_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pr_review_threads ENABLE ROW LEVEL SECURITY;
-- +goose Down
DROP TABLE IF EXISTS ao_pr_review_threads;
DROP INDEX IF EXISTS ao_pr_claims_one_active_owner;
DROP TABLE IF EXISTS ao_pr_claims;
DROP TABLE IF EXISTS ao_session_issue_links;
DROP TABLE IF EXISTS ao_issues;
