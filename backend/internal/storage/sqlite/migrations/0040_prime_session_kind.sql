-- Admit the global prime orchestrator role as a first-class session kind and
-- enforce the mechanical invariant that at most one prime is live fleet-wide.

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
    'CHECK (kind IN (''worker'', ''orchestrator'', ''prime''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = RESET;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX idx_sessions_one_live_prime
    ON sessions (kind)
    WHERE kind = 'prime' AND is_terminated = FALSE;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_sessions_one_live_prime;
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = ON;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(
    sql,
    'CHECK (kind IN (''worker'', ''orchestrator'', ''prime''))',
    'CHECK (kind IN (''worker'', ''orchestrator''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = RESET;
-- +goose StatementEnd
