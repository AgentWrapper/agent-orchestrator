-- +goose Up
CREATE TABLE ao_local_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ao_local_users_email_lower_key ON ao_local_users(lower(email));

CREATE TABLE ao_local_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES ao_local_users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ao_local_sessions_user_id_idx ON ao_local_sessions(user_id);
CREATE INDEX ao_local_sessions_expires_at_idx ON ao_local_sessions(expires_at);

ALTER TABLE ao_local_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_local_sessions ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_local_sessions;
DROP TABLE IF EXISTS ao_local_users;
