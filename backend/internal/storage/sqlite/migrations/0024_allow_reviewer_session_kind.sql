-- Widen sessions.kind for durable reviewer sessions without rebuilding the
-- sessions table and its foreign keys, indexes, and change-log triggers.

-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
PRAGMA writable_schema = ON;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(
    sql,
    'CHECK (kind IN (''worker'', ''orchestrator''))',
    'CHECK (kind IN (''worker'', ''orchestrator'', ''reviewer''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = RESET;
-- +goose StatementEnd

-- +goose Down
-- Downgrade only after removing reviewer sessions through normal product
-- lifecycle; this migration deliberately does not delete durable records.
-- +goose StatementBegin
DROP TABLE IF EXISTS _reviewer_session_down_guard;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TEMP TABLE _reviewer_session_down_guard (ok INTEGER NOT NULL);
-- +goose StatementEnd
-- +goose StatementBegin
INSERT INTO _reviewer_session_down_guard(ok)
SELECT NULL WHERE EXISTS (SELECT 1 FROM sessions WHERE kind = 'reviewer');
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE _reviewer_session_down_guard;
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = ON;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(
    sql,
    'CHECK (kind IN (''worker'', ''orchestrator'', ''reviewer''))',
    'CHECK (kind IN (''worker'', ''orchestrator''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = RESET;
-- +goose StatementEnd
