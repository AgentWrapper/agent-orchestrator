-- +goose Up
-- launched_harnesses records every agent harness that has actually launched for
-- a session, comma-separated. Agent switching reads it to decide resume vs fresh
-- launch: a harness already in the set has a native session on disk (e.g. Claude
-- Code pins a deterministic --session-id), so relaunching it fresh would collide
-- ("session id already in use") — it must resume instead. Durable so the choice
-- survives a daemon restart (the agent's on-disk session does too). Defaulting to
-- '' keeps existing rows valid without backfill.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN launched_harnesses TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- Recreate the sessions update CDC trigger so an idle live switch also fans out
-- a session_updated event. Switch changes harness/runtime/model while activity
-- may remain idle, and other connected clients rely on SSE invalidation to pick
-- up the new agent and terminal handle.
-- +goose StatementBegin
DROP TRIGGER IF EXISTS sessions_cdc_update;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER sessions_cdc_update
AFTER UPDATE ON sessions
WHEN OLD.activity_state <> NEW.activity_state
    OR OLD.is_terminated <> NEW.is_terminated
    OR (OLD.first_signal_at IS NULL AND NEW.first_signal_at IS NOT NULL)
    OR OLD.preview_url <> NEW.preview_url
    OR OLD.preview_revision <> NEW.preview_revision
    OR OLD.harness <> NEW.harness
    OR OLD.runtime_handle_id <> NEW.runtime_handle_id
    OR OLD.model <> NEW.model
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END), 'previewUrl', NEW.preview_url, 'previewRevision', NEW.preview_revision, 'harness', NEW.harness, 'terminalHandleId', NEW.runtime_handle_id, 'model', NEW.model),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS sessions_cdc_update;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER sessions_cdc_update
AFTER UPDATE ON sessions
WHEN OLD.activity_state <> NEW.activity_state
    OR OLD.is_terminated <> NEW.is_terminated
    OR (OLD.first_signal_at IS NULL AND NEW.first_signal_at IS NOT NULL)
    OR OLD.preview_url <> NEW.preview_url
    OR OLD.preview_revision <> NEW.preview_revision
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END), 'previewUrl', NEW.preview_url, 'previewRevision', NEW.preview_revision),
        NEW.updated_at);
END;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN launched_harnesses;
-- +goose StatementEnd
