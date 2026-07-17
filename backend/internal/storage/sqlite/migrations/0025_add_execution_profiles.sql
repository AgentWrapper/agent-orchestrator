-- +goose Up
ALTER TABLE sessions ADD COLUMN execution_profile_json TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN observed_execution_profile_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE session_execution_profile_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    old_profile_json TEXT NOT NULL,
    new_profile_json TEXT NOT NULL,
    authority   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    changed_at  TIMESTAMP NOT NULL
);
CREATE INDEX idx_session_execution_profile_changes_session
    ON session_execution_profile_changes(session_id, changed_at);

-- +goose Down
DROP INDEX idx_session_execution_profile_changes_session;
DROP TABLE session_execution_profile_changes;
ALTER TABLE sessions DROP COLUMN observed_execution_profile_hash;
ALTER TABLE sessions DROP COLUMN execution_profile_json;
