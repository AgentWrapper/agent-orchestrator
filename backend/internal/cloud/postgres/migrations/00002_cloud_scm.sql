-- +goose Up
CREATE TABLE ao_pull_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'github',
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    draft BOOLEAN NOT NULL DEFAULT false,
    head_sha TEXT NOT NULL,
    source_branch TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    ci_state TEXT NOT NULL DEFAULT 'unknown',
    review_state TEXT NOT NULL DEFAULT 'none',
    mergeability TEXT NOT NULL DEFAULT 'unknown',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, repository, number)
);

CREATE INDEX ao_pull_requests_session_idx ON ao_pull_requests(session_id, updated_at DESC);

CREATE TABLE ao_pr_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pull_request_id UUID NOT NULL REFERENCES ao_pull_requests(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    conclusion TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pull_request_id, name)
);

ALTER TABLE ao_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_pr_checks ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_pr_checks;
DROP TABLE IF EXISTS ao_pull_requests;
