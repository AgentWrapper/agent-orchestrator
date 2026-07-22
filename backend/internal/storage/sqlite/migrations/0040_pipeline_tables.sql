-- Pipelines v1 store (issue #229). Four tables back the pipeline subsystem:
--
--   pipeline_definitions  CRUD-authored pipeline configs. Carries BOTH the raw
--                         YAML as authored and the validated, normalized JSON
--                         snapshot (spec §4b). Runs snapshot the JSON at trigger
--                         time so editing a def never mutates a live run.
--   pipeline_runs         one row per execution. Run-level scalars plus the
--                         frozen config snapshot and the run's fingerprint set.
--                         Stages live in pipeline_stage_runs; findings live in
--                         pipeline_artifacts; the full RunState is reconstructed
--                         from all three on hydrate.
--   pipeline_stage_runs   per-stage runtime state within a run, one row per
--                         (run, stage name). stage_run_id is an attribute (it is
--                         reassigned on resume) rather than the key.
--   pipeline_artifacts    findings + JSON artifacts. Immutable payload kept as a
--                         JSON blob; status/sent_to_agent_at are the only mutable
--                         columns and are authoritative over the blob on read.
--
-- (pipeline_thread_messages is phase 2 and intentionally not created here.)
--
-- CDC: triggers on every pipeline_* table write into change_log so pipeline
-- events ride the existing change_log -> /events SSE stream (spec §4b). Pipeline
-- events are project-level (change_log.session_id is left NULL) because a run's
-- session_id may be a manual-run placeholder that is not a real sessions row.
-- Emitting the new event_type values first requires widening the change_log
-- CHECK, which SQLite can only do by rebuilding the table. Rebuilding forces the
-- change_log-referencing CDC triggers to be dropped first (dropping the table
-- while a trigger references it errors) and recreated after; their bodies are
-- the current definitions (sessions_cdc_update carries the 0019 form) so this
-- does not revert 0010/0017/0019.

-- +goose Up
-- +goose StatementBegin
DROP TRIGGER IF EXISTS pr_review_threads_cdc_update;
DROP TRIGGER IF EXISTS pr_review_threads_cdc_insert;
DROP TRIGGER IF EXISTS sessions_cdc_insert;
DROP TRIGGER IF EXISTS sessions_cdc_update;
DROP TRIGGER IF EXISTS pr_cdc_insert;
DROP TRIGGER IF EXISTS pr_cdc_update;
DROP TRIGGER IF EXISTS pr_session_cdc_update;
DROP TRIGGER IF EXISTS pr_checks_cdc_insert;
DROP TRIGGER IF EXISTS pr_checks_cdc_update;

CREATE TABLE change_log_new (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id),
    session_id TEXT REFERENCES sessions (id),
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'session_created',
            'session_updated',
            'pr_created',
            'pr_updated',
            'pr_check_recorded',
            'pr_session_changed',
            'pr_review_thread_added',
            'pr_review_thread_resolved',
            'pipeline_definition_changed',
            'pipeline_run_updated',
            'pipeline_stage_run_updated',
            'pipeline_artifact_updated'
        )),
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO change_log_new (seq, project_id, session_id, event_type, payload, created_at)
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log;

DROP INDEX IF EXISTS idx_change_log_project;
DROP TABLE change_log;
ALTER TABLE change_log_new RENAME TO change_log;
CREATE INDEX idx_change_log_project ON change_log (project_id, seq);
-- +goose StatementEnd

-- Recreate the change_log-referencing CDC triggers (current definitions).
-- +goose StatementBegin
CREATE TRIGGER sessions_cdc_insert
AFTER INSERT ON sessions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_created',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END)),
        NEW.updated_at);
END;
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

-- +goose StatementBegin
CREATE TRIGGER pr_cdc_insert
AFTER INSERT ON pr
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_created',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;
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

-- +goose StatementBegin
CREATE TRIGGER pr_session_cdc_update
AFTER UPDATE ON pr
WHEN OLD.session_id <> NEW.session_id
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id,
        'pr_session_changed',
        json_object(
            'url', NEW.url,
            'fromSession', OLD.session_id,
            'toSession', NEW.session_id),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_checks_cdc_insert
AFTER INSERT ON pr_checks
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_check_recorded',
        json_object('pr', NEW.pr_url, 'name', NEW.name, 'commit', NEW.commit_hash, 'status', NEW.status),
        NEW.created_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_checks_cdc_update
AFTER UPDATE ON pr_checks
WHEN OLD.status <> NEW.status
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_check_recorded',
        json_object('pr', NEW.pr_url, 'name', NEW.name, 'commit', NEW.commit_hash, 'status', NEW.status),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_review_threads_cdc_insert
AFTER INSERT ON pr_review_threads
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_review_thread_added',
        json_object(
            'pr', NEW.pr_url,
            'thread', NEW.thread_id,
            'path', NEW.path,
            'line', NEW.line,
            'resolved', json(CASE WHEN NEW.resolved THEN 'true' ELSE 'false' END),
            'isBot', json(CASE WHEN NEW.is_bot THEN 'true' ELSE 'false' END)
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_review_threads_cdc_update
AFTER UPDATE ON pr_review_threads
WHEN OLD.resolved <> NEW.resolved
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_review_thread_resolved',
        json_object(
            'pr', NEW.pr_url,
            'thread', NEW.thread_id,
            'path', NEW.path,
            'line', NEW.line,
            'resolved', json(CASE WHEN NEW.resolved THEN 'true' ELSE 'false' END)
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE pipeline_definitions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    yaml_source TEXT NOT NULL,
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    created_at  TIMESTAMP NOT NULL,
    updated_at  TIMESTAMP NOT NULL,
    UNIQUE (project_id, name)
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE pipeline_runs (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- pipeline_id references the def this run came from but is NOT a foreign
    -- key: runs snapshot their config and outlive definition deletes.
    pipeline_id        TEXT NOT NULL,
    pipeline_name      TEXT NOT NULL,
    session_id         TEXT NOT NULL DEFAULT '',
    head_sha           TEXT NOT NULL DEFAULT '',
    loop_state         TEXT NOT NULL,
    termination_reason TEXT NOT NULL DEFAULT '',
    loop_rounds        INTEGER NOT NULL DEFAULT 0,
    config_snapshot    TEXT NOT NULL CHECK (json_valid(config_snapshot)),
    fingerprints       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fingerprints)),
    created_at         TIMESTAMP NOT NULL,
    updated_at         TIMESTAMP NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
-- Runs list newest-first per project; the loop index feeds hydrate's
-- currentRunByLoop / historySummaries reconstruction.
CREATE INDEX idx_pipeline_runs_project_created ON pipeline_runs (project_id, created_at DESC);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_pipeline_runs_loop ON pipeline_runs (project_id, session_id, pipeline_name, created_at);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE pipeline_stage_runs (
    run_id        TEXT NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
    project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    stage_name    TEXT NOT NULL,
    stage_run_id  TEXT NOT NULL,
    status        TEXT NOT NULL,
    attempt       INTEGER NOT NULL DEFAULT 0,
    verdict       TEXT NOT NULL DEFAULT '',
    started_at    TIMESTAMP,
    completed_at  TIMESTAMP,
    error_message TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, stage_name)
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE pipeline_artifacts (
    id               TEXT PRIMARY KEY,
    pipeline_run_id  TEXT NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
    project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    stage_run_id     TEXT NOT NULL,
    stage_name       TEXT NOT NULL,
    kind             TEXT NOT NULL,
    fingerprint      TEXT NOT NULL DEFAULT '',
    -- status + sent_to_agent_at are the only mutable fields and are
    -- authoritative over anything in payload on read.
    status           TEXT NOT NULL DEFAULT 'open',
    sent_to_agent_at TIMESTAMP,
    -- payload is the full artifact envelope minus the mutable fields above,
    -- kept as a JSON blob so the append path never has to touch a wide column
    -- list and reconstruction is one unmarshal.
    payload          TEXT NOT NULL CHECK (json_valid(payload)),
    created_at       TIMESTAMP NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_pipeline_artifacts_run ON pipeline_artifacts (pipeline_run_id, created_at);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_pipeline_artifacts_stage_run ON pipeline_artifacts (stage_run_id);
-- +goose StatementEnd

-- Pipeline CDC triggers. All pipeline events are project-level (session_id NULL).

-- +goose StatementBegin
CREATE TRIGGER pipeline_definitions_cdc_insert
AFTER INSERT ON pipeline_definitions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_definition_changed',
        json_object('id', NEW.id, 'name', NEW.name, 'change', 'created'),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_definitions_cdc_update
AFTER UPDATE ON pipeline_definitions
WHEN OLD.updated_at <> NEW.updated_at
    OR OLD.name <> NEW.name
    OR OLD.config_json <> NEW.config_json
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_definition_changed',
        json_object('id', NEW.id, 'name', NEW.name, 'change', 'updated'),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_definitions_cdc_delete
AFTER DELETE ON pipeline_definitions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (OLD.project_id, NULL, 'pipeline_definition_changed',
        json_object('id', OLD.id, 'name', OLD.name, 'change', 'deleted'),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_runs_cdc_insert
AFTER INSERT ON pipeline_runs
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_run_updated',
        json_object(
            'runId', NEW.id,
            'pipelineId', NEW.pipeline_id,
            'pipelineName', NEW.pipeline_name,
            'sessionId', NEW.session_id,
            'headSha', NEW.head_sha,
            'loopState', NEW.loop_state,
            'terminationReason', NEW.termination_reason,
            'loopRounds', NEW.loop_rounds),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_runs_cdc_update
AFTER UPDATE ON pipeline_runs
WHEN OLD.updated_at <> NEW.updated_at
    OR OLD.loop_state <> NEW.loop_state
    OR OLD.loop_rounds <> NEW.loop_rounds
    OR OLD.termination_reason <> NEW.termination_reason
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_run_updated',
        json_object(
            'runId', NEW.id,
            'pipelineId', NEW.pipeline_id,
            'pipelineName', NEW.pipeline_name,
            'sessionId', NEW.session_id,
            'headSha', NEW.head_sha,
            'loopState', NEW.loop_state,
            'terminationReason', NEW.termination_reason,
            'loopRounds', NEW.loop_rounds),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_stage_runs_cdc_insert
AFTER INSERT ON pipeline_stage_runs
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_stage_run_updated',
        json_object(
            'runId', NEW.run_id,
            'stageRunId', NEW.stage_run_id,
            'stageName', NEW.stage_name,
            'status', NEW.status,
            'attempt', NEW.attempt,
            'verdict', NEW.verdict),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_stage_runs_cdc_update
AFTER UPDATE ON pipeline_stage_runs
WHEN OLD.status <> NEW.status
    OR OLD.attempt <> NEW.attempt
    OR OLD.verdict <> NEW.verdict
    OR OLD.stage_run_id <> NEW.stage_run_id
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_stage_run_updated',
        json_object(
            'runId', NEW.run_id,
            'stageRunId', NEW.stage_run_id,
            'stageName', NEW.stage_name,
            'status', NEW.status,
            'attempt', NEW.attempt,
            'verdict', NEW.verdict),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_artifacts_cdc_insert
AFTER INSERT ON pipeline_artifacts
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_artifact_updated',
        json_object(
            'artifactId', NEW.id,
            'runId', NEW.pipeline_run_id,
            'stageRunId', NEW.stage_run_id,
            'stageName', NEW.stage_name,
            'kind', NEW.kind,
            'status', NEW.status,
            'fingerprint', NEW.fingerprint),
        NEW.created_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_artifacts_cdc_update
AFTER UPDATE ON pipeline_artifacts
WHEN OLD.status <> NEW.status
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_artifact_updated',
        json_object(
            'artifactId', NEW.id,
            'runId', NEW.pipeline_run_id,
            'stageRunId', NEW.stage_run_id,
            'stageName', NEW.stage_name,
            'kind', NEW.kind,
            'status', NEW.status,
            'fingerprint', NEW.fingerprint),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS pipeline_artifacts_cdc_update;
DROP TRIGGER IF EXISTS pipeline_artifacts_cdc_insert;
DROP TRIGGER IF EXISTS pipeline_stage_runs_cdc_update;
DROP TRIGGER IF EXISTS pipeline_stage_runs_cdc_insert;
DROP TRIGGER IF EXISTS pipeline_runs_cdc_update;
DROP TRIGGER IF EXISTS pipeline_runs_cdc_insert;
DROP TRIGGER IF EXISTS pipeline_definitions_cdc_delete;
DROP TRIGGER IF EXISTS pipeline_definitions_cdc_update;
DROP TRIGGER IF EXISTS pipeline_definitions_cdc_insert;
DROP TABLE IF EXISTS pipeline_artifacts;
DROP TABLE IF EXISTS pipeline_stage_runs;
DROP TABLE IF EXISTS pipeline_runs;
DROP TABLE IF EXISTS pipeline_definitions;

DROP TRIGGER IF EXISTS pr_review_threads_cdc_update;
DROP TRIGGER IF EXISTS pr_review_threads_cdc_insert;
DROP TRIGGER IF EXISTS sessions_cdc_insert;
DROP TRIGGER IF EXISTS sessions_cdc_update;
DROP TRIGGER IF EXISTS pr_cdc_insert;
DROP TRIGGER IF EXISTS pr_cdc_update;
DROP TRIGGER IF EXISTS pr_session_cdc_update;
DROP TRIGGER IF EXISTS pr_checks_cdc_insert;
DROP TRIGGER IF EXISTS pr_checks_cdc_update;

CREATE TABLE change_log_old (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id),
    session_id TEXT REFERENCES sessions (id),
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'session_created',
            'session_updated',
            'pr_created',
            'pr_updated',
            'pr_check_recorded',
            'pr_session_changed',
            'pr_review_thread_added',
            'pr_review_thread_resolved'
        )),
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO change_log_old (seq, project_id, session_id, event_type, payload, created_at)
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log
WHERE event_type NOT LIKE 'pipeline_%';

DROP INDEX IF EXISTS idx_change_log_project;
DROP TABLE change_log;
ALTER TABLE change_log_old RENAME TO change_log;
CREATE INDEX idx_change_log_project ON change_log (project_id, seq);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER sessions_cdc_insert
AFTER INSERT ON sessions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_created',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END)),
        NEW.updated_at);
END;
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

-- +goose StatementBegin
CREATE TRIGGER pr_cdc_insert
AFTER INSERT ON pr
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_created',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;
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

-- +goose StatementBegin
CREATE TRIGGER pr_session_cdc_update
AFTER UPDATE ON pr
WHEN OLD.session_id <> NEW.session_id
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id,
        'pr_session_changed',
        json_object(
            'url', NEW.url,
            'fromSession', OLD.session_id,
            'toSession', NEW.session_id),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_checks_cdc_insert
AFTER INSERT ON pr_checks
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_check_recorded',
        json_object('pr', NEW.pr_url, 'name', NEW.name, 'commit', NEW.commit_hash, 'status', NEW.status),
        NEW.created_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_checks_cdc_update
AFTER UPDATE ON pr_checks
WHEN OLD.status <> NEW.status
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_check_recorded',
        json_object('pr', NEW.pr_url, 'name', NEW.name, 'commit', NEW.commit_hash, 'status', NEW.status),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_review_threads_cdc_insert
AFTER INSERT ON pr_review_threads
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_review_thread_added',
        json_object(
            'pr', NEW.pr_url,
            'thread', NEW.thread_id,
            'path', NEW.path,
            'line', NEW.line,
            'resolved', json(CASE WHEN NEW.resolved THEN 'true' ELSE 'false' END),
            'isBot', json(CASE WHEN NEW.is_bot THEN 'true' ELSE 'false' END)
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pr_review_threads_cdc_update
AFTER UPDATE ON pr_review_threads
WHEN OLD.resolved <> NEW.resolved
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT s.project_id FROM pr p JOIN sessions s ON s.id = p.session_id WHERE p.url = NEW.pr_url),
        (SELECT session_id FROM pr WHERE url = NEW.pr_url),
        'pr_review_thread_resolved',
        json_object(
            'pr', NEW.pr_url,
            'thread', NEW.thread_id,
            'path', NEW.path,
            'line', NEW.line,
            'resolved', json(CASE WHEN NEW.resolved THEN 'true' ELSE 'false' END)
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd
