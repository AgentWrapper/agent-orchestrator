-- +goose Up
CREATE TABLE ao_github_user_auth_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES ao_users(id) ON DELETE CASCADE,
    state_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    code_verifier_encrypted BYTEA NOT NULL CHECK (octet_length(code_verifier_encrypted) > 0),
    code_verifier_nonce BYTEA NOT NULL CHECK (octet_length(code_verifier_nonce) > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX ao_github_user_auth_attempts_user_created_idx
    ON ao_github_user_auth_attempts(user_id, created_at DESC);

CREATE TABLE ao_github_user_connections (
    user_id UUID PRIMARY KEY REFERENCES ao_users(id) ON DELETE CASCADE,
    github_user_id BIGINT NOT NULL UNIQUE CHECK (github_user_id > 0),
    github_login TEXT NOT NULL CHECK (github_login <> ''),
    github_avatar_url TEXT NOT NULL DEFAULT '',
    access_token_encrypted BYTEA NOT NULL CHECK (octet_length(access_token_encrypted) > 0),
    access_token_nonce BYTEA NOT NULL CHECK (octet_length(access_token_nonce) > 0),
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_encrypted BYTEA,
    refresh_token_nonce BYTEA,
    refresh_token_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'expired')),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (refresh_token_encrypted IS NULL AND refresh_token_nonce IS NULL
            AND refresh_token_expires_at IS NULL)
        OR
        (refresh_token_encrypted IS NOT NULL AND refresh_token_nonce IS NOT NULL
            AND refresh_token_expires_at IS NOT NULL)
    ),
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE INDEX ao_github_user_connections_status_idx
    ON ao_github_user_connections(status, updated_at);

ALTER TABLE ao_github_user_auth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_github_user_connections ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_github_user_connections;
DROP TABLE IF EXISTS ao_github_user_auth_attempts;
