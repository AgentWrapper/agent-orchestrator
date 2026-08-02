-- +goose Up
-- Two pipeline facts on the session row.
--
-- pipeline_run_id records the pipeline run that spawned the session. It is the
-- session trigger bridge's loop guard: without a durable marker, a pipeline
-- agent going idle fires the session pipelines, whose agents go idle, forever.
-- It must survive a daemon restart, so it is a column and not in-process state.
--
-- pipeline_orphan is the JSON PipelineOrphanInfo a stage writes when its
-- kill-on rule spared the session (no_output, no_signal, timed_out): the run,
-- the stage, the outcome that spared it and when it was kept. Empty string
-- means the session is not pipeline-orphaned. JSON rather than five columns
-- because nothing queries inside it: the daemon reads it whole and the session
-- list renders it whole.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN pipeline_run_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN pipeline_orphan TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- Recreate the sessions update CDC trigger so marking a session
-- pipeline-orphaned fans out a session_updated event. Without this the badge
-- would only appear on the next unrelated session change, which is exactly the
-- moment nobody is looking. Guard-only change: session_updated is an
-- invalidation nudge, so the payload stays as-is.
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
    OR OLD.terminate_on_pr_merge <> NEW.terminate_on_pr_merge
    OR OLD.pipeline_orphan <> NEW.pipeline_orphan
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object(
            'id', NEW.id,
            'activity', NEW.activity_state,
            'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END),
            'terminateOnPrMerge', json(CASE WHEN NEW.terminate_on_pr_merge THEN 'true' ELSE 'false' END),
            'previewUrl', NEW.preview_url,
            'previewRevision', NEW.preview_revision
        ),
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
    OR OLD.display_name <> NEW.display_name
    OR OLD.terminate_on_pr_merge <> NEW.terminate_on_pr_merge
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object(
            'id', NEW.id,
            'activity', NEW.activity_state,
            'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END),
            'terminateOnPrMerge', json(CASE WHEN NEW.terminate_on_pr_merge THEN 'true' ELSE 'false' END),
            'previewUrl', NEW.preview_url,
            'previewRevision', NEW.preview_revision
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN pipeline_orphan;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN pipeline_run_id;
-- +goose StatementEnd
