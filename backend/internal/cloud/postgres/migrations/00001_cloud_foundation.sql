-- +goose Up
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE ao_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ao_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, repository_url)
);

CREATE TABLE ao_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ao_projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('worker', 'orchestrator')),
    harness TEXT NOT NULL,
    display_name TEXT NOT NULL,
    branch TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    activity_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (activity_state IN ('active', 'idle', 'waiting_input', 'blocked', 'exited')),
    is_terminated BOOLEAN NOT NULL DEFAULT false,
    agent_session_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ao_sessions_one_active_orchestrator
    ON ao_sessions(project_id)
    WHERE kind = 'orchestrator' AND is_terminated = false;

CREATE TABLE ao_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    session_id UUID REFERENCES ao_sessions(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('accepted', 'running', 'succeeded', 'failed')),
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, idempotency_key)
);

CREATE TABLE ao_session_sequences (
    session_id UUID PRIMARY KEY REFERENCES ao_sessions(id) ON DELETE CASCADE,
    next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
);

CREATE TABLE ao_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, sequence)
);

CREATE INDEX ao_events_replay_idx ON ao_events(session_id, sequence);

CREATE TABLE ao_sandboxes (
    session_id UUID PRIMARY KEY REFERENCES ao_sessions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_environment_id TEXT,
    provider_connection_id UUID,
    desired_state TEXT NOT NULL DEFAULT 'running'
        CHECK (desired_state IN ('running', 'paused', 'deleted')),
    observed_state TEXT NOT NULL DEFAULT 'requested'
        CHECK (observed_state IN (
            'requested',
            'provisioning',
            'bootstrapping',
            'ready',
            'running',
            'paused',
            'stopped',
            'disconnected',
            'deleting',
            'deleted',
            'failed'
        )),
    resource_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    worker_last_seen_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    reconcile_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    reconcile_lease_until TIMESTAMPTZ,
    reconcile_lease_owner TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_environment_id)
);

CREATE TABLE ao_provider_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    encrypted_secret BYTEA NOT NULL,
    secret_nonce BYTEA NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    validation_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (validation_state IN ('pending', 'valid', 'invalid')),
    validated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, provider, label)
);

ALTER TABLE ao_sandboxes
    ADD CONSTRAINT ao_sandboxes_provider_connection_fk
    FOREIGN KEY (provider_connection_id)
    REFERENCES ao_provider_connections(id)
    ON DELETE SET NULL;

CREATE TABLE ao_worker_connections (
    session_id UUID PRIMARY KEY REFERENCES ao_sessions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    sandbox_id UUID NOT NULL REFERENCES ao_sandboxes(session_id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL CHECK (epoch > 0),
    worker_id TEXT NOT NULL,
    version TEXT NOT NULL,
    capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disconnected_at TIMESTAMPTZ
);

CREATE TABLE ao_access_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ao_audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    actor_user_id UUID,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ao_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_session_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_sandboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_worker_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_access_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_audit_events ENABLE ROW LEVEL SECURITY;

-- Cloud data is served only through the authenticated Go control plane.
-- No Data API policy is intentionally granted to anon/authenticated roles.

-- +goose Down
DROP TABLE IF EXISTS ao_audit_events;
DROP TABLE IF EXISTS ao_access_tickets;
DROP TABLE IF EXISTS ao_worker_connections;
ALTER TABLE IF EXISTS ao_sandboxes DROP CONSTRAINT IF EXISTS ao_sandboxes_provider_connection_fk;
DROP TABLE IF EXISTS ao_provider_connections;
DROP TABLE IF EXISTS ao_sandboxes;
DROP TABLE IF EXISTS ao_events;
DROP TABLE IF EXISTS ao_session_sequences;
DROP TABLE IF EXISTS ao_commands;
DROP TABLE IF EXISTS ao_sessions;
DROP TABLE IF EXISTS ao_projects;
DROP TABLE IF EXISTS ao_accounts;
