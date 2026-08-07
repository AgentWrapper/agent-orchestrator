-- +goose Up
CREATE TABLE ao_session_environments (
    session_id UUID PRIMARY KEY REFERENCES ao_sessions(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
    encrypted_values BYTEA NOT NULL,
    values_nonce BYTEA NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by_user_id UUID REFERENCES ao_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, session_id)
);

ALTER TABLE ao_session_environments ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_session_environments;
