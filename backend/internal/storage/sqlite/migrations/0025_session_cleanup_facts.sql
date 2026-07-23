-- +goose Up

-- cleanup_generation is a monotonic counter on the session row, bumped each time
-- a session is un-terminated (spawn/restore). The terminal-resource reconciler
-- stamps every session_cleanup_facts row with the generation it was written for,
-- so a finalize begun under generation N can be rejected if a Restore->Terminate
-- cycle advanced the counter to N+1 before it persisted. Additive only here:
-- nothing bumps it yet, so every existing and new row keeps the default 0. It is
-- deliberately left OUT of the sessions_cdc_update WHEN-guard and payload — the
-- bump (added later) rides the is_terminated flip that already fans out.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN cleanup_generation INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- session_cleanup_facts records the durable disposition of a terminated session's
-- runtime + workspace teardown. `is_terminated=true` is the intent to release
-- runtime resources; this table records whether that release is still pending,
-- done, blocked on a dirty worktree, or exhausted after the retry cap. It is
-- deliberately NOT a display-status store (status stays derived from durable
-- facts) — it holds only teardown facts. Shape mirrors session_worktrees (0009):
-- a session-keyed child table with an FK ON DELETE CASCADE, a CHECK-constrained
-- enum column, and an explicit index.
--
--   session_generation    the sessions.cleanup_generation this row was written for
--   runtime_released_at    when the runtime handle was genuinely released (NULL = not yet)
--   workspace_disposition  session-level rollup for the UI; per-repo state stays in
--                          session_worktrees.state. 'failed' is the exhausted state
--                          after the retry cap for a non-dirty teardown failure; it
--                          stops auto-retry and is cleared only by a user retry.
--   attempt_count/last_attempt_at/next_attempt_at  capped-backoff retry bookkeeping
--   failure_code           machine code for the last teardown failure ('' = none)
-- +goose StatementBegin
CREATE TABLE session_cleanup_facts (
    session_id            TEXT NOT NULL PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    session_generation    INTEGER NOT NULL DEFAULT 0,
    runtime_released_at   TIMESTAMP,
    workspace_disposition TEXT NOT NULL DEFAULT 'pending'
        CHECK (workspace_disposition IN ('pending', 'removed', 'preserved_dirty', 'failed', 'not_applicable')),
    attempt_count         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at       TIMESTAMP,
    next_attempt_at       TIMESTAMP,
    failure_code          TEXT NOT NULL DEFAULT ''
);
-- Supports the reconciler's periodic capped-backoff retry sweep, which scans for
-- pending rows whose next_attempt_at is due.
CREATE INDEX idx_session_cleanup_facts_next_attempt ON session_cleanup_facts (next_attempt_at);
-- +goose StatementEnd

-- CDC: emit the EXISTING session_updated event (no change_log rebuild, no new
-- event_type, no trigger recreation) so the frontend refetches a session's
-- cleanup facts as they change. The payload is {id}-only and deliberately carries
-- NO isTerminated field: the reconciler's live-wake filter enqueues only
-- session_updated events whose payload reports isTerminated=true, so a facts-only
-- event is naturally ignored by the reconciler and serves purely as a frontend
-- refetch nudge. project_id is resolved via subquery like the pr_* triggers, and
-- created_at reuses the change_log column's own datetime('now') format.
-- +goose StatementBegin
CREATE TRIGGER session_cleanup_facts_cdc_insert
AFTER INSERT ON session_cleanup_facts
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'session_updated',
        json_object('id', NEW.session_id),
        datetime('now'));
END;
-- +goose StatementEnd

-- Fire only on meaningful disposition / runtime-release transitions. The
-- retry-bookkeeping columns (attempt_count, last_attempt_at, next_attempt_at) are
-- EXCLUDED from the WHEN guard, so a pure retry-scheduling write emits no event
-- and cannot self-wake the reconciler or flood the frontend with no-op updates.
-- +goose StatementBegin
CREATE TRIGGER session_cleanup_facts_cdc_update
AFTER UPDATE ON session_cleanup_facts
WHEN OLD.workspace_disposition <> NEW.workspace_disposition
    OR (OLD.runtime_released_at IS NULL) <> (NEW.runtime_released_at IS NULL)
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'session_updated',
        json_object('id', NEW.session_id),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose Down
-- Best-effort, dev-only (Down is exercised by neither prod nor CI). Drop in
-- reverse dependency order: triggers, then the table, then the additive column
-- (SQLite ALTER ... DROP COLUMN is supported here — 0019's Down drops a column).
-- +goose StatementBegin
DROP TRIGGER IF EXISTS session_cleanup_facts_cdc_update;
DROP TRIGGER IF EXISTS session_cleanup_facts_cdc_insert;
DROP TABLE IF EXISTS session_cleanup_facts;
ALTER TABLE sessions DROP COLUMN cleanup_generation;
-- +goose StatementEnd
