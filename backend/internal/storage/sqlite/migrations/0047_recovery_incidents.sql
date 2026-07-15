-- +goose Up
-- +goose StatementBegin
CREATE TABLE recovery_incidents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'verifying', 'resolved')),
    rung TEXT NOT NULL CHECK (rung IN ('worker', 'orc', 'prime')),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    dead_session_id TEXT NOT NULL,
    last_session_id TEXT NOT NULL,
    terminal_failure_reason TEXT NOT NULL DEFAULT '',
    failure_point TEXT NOT NULL DEFAULT '',
	open_pr_url TEXT NOT NULL DEFAULT '',
	fix_reference TEXT NOT NULL DEFAULT '',
	last_failed_fix_reference TEXT NOT NULL DEFAULT '',
	verification_session_id TEXT NOT NULL DEFAULT '',
    diagnosis TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    resolved_at TIMESTAMP
);

CREATE UNIQUE INDEX idx_recovery_incidents_unresolved_fingerprint
    ON recovery_incidents(project_id, issue_id, fingerprint)
    WHERE status != 'resolved';

CREATE INDEX idx_recovery_incidents_unresolved_session
    ON recovery_incidents(dead_session_id)
    WHERE status != 'resolved';

CREATE INDEX idx_recovery_incidents_unresolved_verification_session
    ON recovery_incidents(verification_session_id)
    WHERE status != 'resolved' AND verification_session_id != '';

CREATE INDEX idx_recovery_incidents_project_issue
    ON recovery_incidents(project_id, issue_id, updated_at DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_recovery_incidents_project_issue;
DROP INDEX IF EXISTS idx_recovery_incidents_unresolved_verification_session;
DROP INDEX IF EXISTS idx_recovery_incidents_unresolved_session;
DROP INDEX IF EXISTS idx_recovery_incidents_unresolved_fingerprint;
DROP TABLE IF EXISTS recovery_incidents;
-- +goose StatementEnd
