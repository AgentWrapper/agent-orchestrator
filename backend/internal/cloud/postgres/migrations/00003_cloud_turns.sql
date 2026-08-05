-- +goose Up
CREATE TABLE ao_turns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ao_accounts(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES ao_sessions(id) ON DELETE CASCADE,
    user_message_sequence BIGINT NOT NULL CHECK (user_message_sequence > 0),
    state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN (
            'queued',
            'provisioning',
            'running',
            'cancel_requested',
            'completed',
            'failed'
        )),
    worker_epoch BIGINT NOT NULL DEFAULT 0 CHECK (worker_epoch >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    error_message TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, user_message_sequence),
    FOREIGN KEY (session_id, user_message_sequence)
        REFERENCES ao_events(session_id, sequence)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX ao_turns_one_active_per_session
    ON ao_turns(session_id)
    WHERE state IN ('queued', 'provisioning', 'running', 'cancel_requested');

CREATE INDEX ao_turns_session_created_idx
    ON ao_turns(session_id, created_at DESC);

ALTER TABLE ao_turns ENABLE ROW LEVEL SECURITY;

-- Cloud data is served only through the authenticated Go control plane.
-- No Data API policy is intentionally granted to anon/authenticated roles.

-- +goose Down
DROP TABLE IF EXISTS ao_turns;
