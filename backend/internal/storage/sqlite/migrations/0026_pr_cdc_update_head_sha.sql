-- New-SHA cancel-and-rearm (spec decision 9) rides the CDC pr_updated event, but
-- the pr_cdc_update trigger (migration 0024) fired only when pr_state, ci_state,
-- review_decision, or mergeability changed. A push that changes ONLY pr.head_sha
-- (no CI reporting yet, or a repo without CI) emitted no event, so the pipeline
-- trigger bridge never saw the new SHA: the stale run kept running and no fresh
-- run armed. Add OLD.head_sha <> NEW.head_sha to the WHEN clause so a head-SHA
-- change alone emits pr_updated. The payload is unchanged (the bridge reads
-- head_sha from the store by url, not from the payload).

-- +goose Up
-- +goose StatementBegin
DROP TRIGGER IF EXISTS pr_cdc_update;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_cdc_update
AFTER UPDATE ON pr
WHEN OLD.pr_state <> NEW.pr_state
    OR OLD.ci_state <> NEW.ci_state
    OR OLD.review_decision <> NEW.review_decision
    OR OLD.mergeability <> NEW.mergeability
    OR OLD.head_sha <> NEW.head_sha
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_updated',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS pr_cdc_update;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_cdc_update
AFTER UPDATE ON pr
WHEN OLD.pr_state <> NEW.pr_state
    OR OLD.ci_state <> NEW.ci_state
    OR OLD.review_decision <> NEW.review_decision
    OR OLD.mergeability <> NEW.mergeability
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_updated',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;
-- +goose StatementEnd
