-- +goose Up
-- +goose StatementBegin

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    google_subject TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE org_members (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE teams (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, name)
);

CREATE TABLE team_members (
    org_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, team_id, user_id),
    FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id) ON DELETE CASCADE
);

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    device_code_hash TEXT NOT NULL UNIQUE,
    user_code TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL DEFAULT '',
    approved_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('refresh', 'api')),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE agent_credentials (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    key_id TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, id)
);

CREATE TABLE repo_connections (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    provider TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    external_id TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, provider, host, owner, repo)
);

CREATE TABLE sandboxes (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, id)
);

CREATE TABLE usage_events (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    metric TEXT NOT NULL CHECK (metric IN ('sandbox_seconds')),
    quantity BIGINT NOT NULL CHECK (quantity >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (org_id, id)
);
CREATE INDEX idx_usage_events_org_time ON usage_events(org_id, occurred_at);

CREATE TABLE audit_log (
    org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
    id TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id)
);
CREATE INDEX idx_audit_log_org_time ON audit_log(org_id, created_at);

CREATE TABLE projects (
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    path TEXT NOT NULL,
    repo_origin_url TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    registered_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ,
    config JSONB,
    kind TEXT NOT NULL DEFAULT 'single_repo'
        CHECK (kind IN ('single_repo', 'workspace', 'scratch')),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, path)
);

CREATE TABLE workspace_repos (
    org_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    repo_origin_url TEXT NOT NULL DEFAULT '',
    registered_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, project_id, name),
    UNIQUE (org_id, project_id, relative_path),
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);

CREATE TABLE sessions (
    org_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    num BIGINT NOT NULL,
    issue_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'worker'
        CHECK (kind IN ('worker', 'orchestrator')),
    harness TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    activity_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (activity_state IN ('active', 'idle', 'waiting_input', 'blocked', 'exited')),
    activity_last_at TIMESTAMPTZ NOT NULL,
    first_signal_at TIMESTAMPTZ,
    is_terminated BOOLEAN NOT NULL DEFAULT FALSE,
    branch TEXT NOT NULL DEFAULT '',
    workspace_path TEXT NOT NULL DEFAULT '',
    workspace_repo_path TEXT NOT NULL DEFAULT '',
    runtime_handle_id TEXT NOT NULL DEFAULT '',
    runtime_launch_id TEXT NOT NULL DEFAULT '',
    agent_session_id TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    preview_url TEXT NOT NULL DEFAULT '',
    preview_revision BIGINT NOT NULL DEFAULT 0,
    terminate_on_pr_merge BOOLEAN NOT NULL DEFAULT FALSE,
    cleanup_generation BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, project_id, num),
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX idx_sessions_org_project ON sessions(org_id, project_id);

CREATE TABLE session_worktrees (
    org_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    preserved_ref TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'removed', 'retry_remove', 'unavailable', 'stray_moved')),
    PRIMARY KEY (org_id, session_id, repo_name),
    FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);

CREATE TABLE pr (
    org_id TEXT NOT NULL,
    url TEXT NOT NULL,
    session_id TEXT NOT NULL,
    number INTEGER NOT NULL DEFAULT 0,
    pr_state TEXT NOT NULL DEFAULT 'open'
        CHECK (pr_state IN ('draft', 'open', 'merged', 'closed')),
    review_decision TEXT NOT NULL DEFAULT 'none'
        CHECK (review_decision IN ('none', 'approved', 'changes_requested', 'review_required')),
    ci_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (ci_state IN ('unknown', 'pending', 'passing', 'failing')),
    mergeability TEXT NOT NULL DEFAULT 'unknown'
        CHECK (mergeability IN ('unknown', 'mergeable', 'conflicting', 'blocked', 'unstable')),
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, url),
    FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);

CREATE TABLE pr_checks (
    org_id TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    name TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'queued', 'in_progress', 'passed', 'failed', 'skipped', 'cancelled')),
    url TEXT NOT NULL DEFAULT '',
    log_tail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, pr_url, name, commit_hash),
    FOREIGN KEY (org_id, pr_url) REFERENCES pr(org_id, url) ON DELETE CASCADE
);

CREATE TABLE pr_comment (
    org_id TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL DEFAULT '',
    line INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL DEFAULT '',
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, pr_url, comment_id),
    FOREIGN KEY (org_id, pr_url) REFERENCES pr(org_id, url) ON DELETE CASCADE
);

CREATE TABLE change_log (
    seq BIGSERIAL PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('session_created', 'session_updated', 'pr_created', 'pr_updated', 'pr_check_recorded', 'pr_session_changed', 'pr_review_thread_added', 'pr_review_thread_resolved')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_change_log_org_seq ON change_log(org_id, seq);

CREATE OR REPLACE FUNCTION sessions_cdc_insert_fn() RETURNS trigger AS $$
BEGIN
    INSERT INTO change_log (org_id, project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.org_id, NEW.project_id, NEW.id, 'session_created',
        jsonb_build_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', NEW.is_terminated),
        NEW.updated_at);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_cdc_insert
AFTER INSERT ON sessions
FOR EACH ROW EXECUTE FUNCTION sessions_cdc_insert_fn();

CREATE OR REPLACE FUNCTION sessions_cdc_update_fn() RETURNS trigger AS $$
BEGIN
    IF OLD.activity_state <> NEW.activity_state
        OR OLD.is_terminated <> NEW.is_terminated
        OR OLD.display_name <> NEW.display_name
        OR OLD.preview_url <> NEW.preview_url THEN
        INSERT INTO change_log (org_id, project_id, session_id, event_type, payload, created_at)
        VALUES (NEW.org_id, NEW.project_id, NEW.id, 'session_updated',
            jsonb_build_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', NEW.is_terminated),
            NEW.updated_at);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_cdc_update
AFTER UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION sessions_cdc_update_fn();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS sessions_cdc_update ON sessions;
DROP FUNCTION IF EXISTS sessions_cdc_update_fn();
DROP TRIGGER IF EXISTS sessions_cdc_insert ON sessions;
DROP FUNCTION IF EXISTS sessions_cdc_insert_fn();
DROP TABLE IF EXISTS change_log;
DROP TABLE IF EXISTS pr_comment;
DROP TABLE IF EXISTS pr_checks;
DROP TABLE IF EXISTS pr;
DROP TABLE IF EXISTS session_worktrees;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS workspace_repos;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS sandboxes;
DROP TABLE IF EXISTS repo_connections;
DROP TABLE IF EXISTS agent_credentials;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS org_members;
DROP TABLE IF EXISTS orgs;
DROP TABLE IF EXISTS users;
-- +goose StatementEnd

