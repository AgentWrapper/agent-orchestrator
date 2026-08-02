-- +goose Up
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_orchestrator_reengagements_due;
DROP INDEX IF EXISTS idx_orchestrator_reengagements_attention;
DROP TABLE IF EXISTS orchestrator_reengagements;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE TABLE orchestrator_reengagements (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMP NOT NULL,
    last_attempt_at TIMESTAMP,
    progress_since_attempt BOOLEAN NOT NULL DEFAULT 0,
    attention_notified BOOLEAN NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'completed', 'exhausted')),
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_orchestrator_reengagements_due
    ON orchestrator_reengagements(state, next_attempt_at)
    WHERE state = 'active';

CREATE INDEX idx_orchestrator_reengagements_attention
    ON orchestrator_reengagements(state, attention_notified)
    WHERE state = 'exhausted' AND attention_notified = 0;
-- +goose StatementEnd
