-- +goose Up
-- Recreate the sessions update CDC trigger so a display_name change also fans
-- out a session_updated event. RenameSession (PATCH /sessions/{id}) writes only
-- display_name + updated_at, but the prior trigger's WHEN clause watched
-- activity_state/is_terminated/first_signal_at/preview_url/preview_revision and
-- NOT display_name, so a rename wrote no change_log row and never reached the
-- live SSE stream — the sidebar only picked up the new name on a full refetch.
-- Migrations 0017/0019 extended this same trigger for preview fan-out; rename
-- was left out. display_name is NOT NULL, so a plain <> comparison is complete.
-- Only the WHEN guard changes: session_updated is an invalidation-only nudge
-- (every renderer consumer treats it as a signal to refetch the workspace, see
-- renderer/lib/event-transport.ts — no consumer reads fields off the payload),
-- so the new name is derived from durable state on refetch, not carried on the
-- event. The payload is left as-is to keep one invalidation-only contract for
-- session_updated across every emitter of it.
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
    OR OLD.display_name <> NEW.display_name
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END), 'previewUrl', NEW.preview_url, 'previewRevision', NEW.preview_revision),
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
