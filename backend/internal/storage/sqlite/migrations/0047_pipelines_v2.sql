-- Pipelines v2 store. v1 shipped only behind the AO_PIPELINES flag and was
-- never released, so no data is owed a migration: the run tables are dropped
-- and recreated in the v2 shape rather than backfilled.
--
--   pipeline_definitions  UNCHANGED. Definitions travel as raw YAML plus a
--                         parsed snapshot; v1 YAML simply fails v2 validation
--                         when the editor opens it.
--   pipeline_runs         one row per run. Run-level scalars, the flattened
--                         subject, and the frozen definition the run executes.
--   pipeline_stage_runs   one row per (run, stage), mirroring pipeline.StageState.
--   pipeline_stage_signals  append-only `ao pipeline done|fail` signals; reads
--                         take the latest row for a (run, stage).
--   pipeline_credentials  engine-held command-stage credentials. Values live
--                         only in the daemon and are never echoed by a read
--                         path a human can reach.
--   pipeline_artifacts    DROPPED with the whole findings subsystem.
--
-- Three columns are not in the v2 design's scalar list but are required for a
-- run to survive a daemon restart, since SQLite (not the run folder) is the
-- store of record: definition_json (the frozen definition), the PR branch pair
-- (a `workspace: checkout` stage needs them after a restart), and the per-stage
-- nudged flag (RunState.Nudged).
--
-- change_log keeps its CHECK list as written in 0040: 'pipeline_artifact_updated'
-- stays a legal value with no emitter, because narrowing the CHECK means
-- rebuilding change_log and re-creating every CDC trigger in the schema for no
-- behavioural gain.

-- +goose Up
-- +goose StatementBegin
DROP TRIGGER IF EXISTS pipeline_artifacts_cdc_update;
DROP TRIGGER IF EXISTS pipeline_artifacts_cdc_insert;
DROP TRIGGER IF EXISTS pipeline_stage_runs_cdc_update;
DROP TRIGGER IF EXISTS pipeline_stage_runs_cdc_insert;
DROP TRIGGER IF EXISTS pipeline_runs_cdc_update;
DROP TRIGGER IF EXISTS pipeline_runs_cdc_insert;
DROP INDEX IF EXISTS idx_pipeline_artifacts_stage_run;
DROP INDEX IF EXISTS idx_pipeline_artifacts_run;
DROP INDEX IF EXISTS idx_pipeline_runs_loop;
DROP INDEX IF EXISTS idx_pipeline_runs_project_created;
DROP TABLE IF EXISTS pipeline_artifacts;
DROP TABLE IF EXISTS pipeline_stage_runs;
DROP TABLE IF EXISTS pipeline_runs;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE pipeline_runs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- pipeline_id names the definition this run came from but is NOT a foreign
    -- key: a run freezes its definition and outlives a definition delete.
    pipeline_id     TEXT NOT NULL,
    pipeline_name   TEXT NOT NULL,
    -- Subject, flattened. session_id is set for session subjects and for PR
    -- subjects that have a local session; the pr_* columns are set for PR
    -- subjects only (a sessionless PR subject is first class).
    subject_kind    TEXT NOT NULL,
    session_id      TEXT NOT NULL DEFAULT '',
    pr_number       INTEGER NOT NULL DEFAULT 0,
    pr_repo         TEXT NOT NULL DEFAULT '',
    pr_url          TEXT NOT NULL DEFAULT '',
    head_sha        TEXT NOT NULL DEFAULT '',
    pr_head_branch  TEXT NOT NULL DEFAULT '',
    pr_base_branch  TEXT NOT NULL DEFAULT '',
    from_fork       INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    run_dir         TEXT NOT NULL DEFAULT '',
    -- The definition as frozen at trigger time. Editing a definition never
    -- changes a run in flight, and hydration on restart replays what ran.
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    cancel_reason   TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP NOT NULL,
    -- NULL while the run is in flight. Hydration selects on it, so it is the
    -- one nullable timestamp on the row.
    settled_at      TIMESTAMP
);
-- +goose StatementEnd

-- +goose StatementBegin
-- The Kanban board lists a project's runs newest-first.
CREATE INDEX idx_pipeline_runs_project_created ON pipeline_runs (project_id, created_at DESC);
-- +goose StatementEnd

-- +goose StatementBegin
-- Hydration on engine start reads exactly the unsettled runs of one project.
CREATE INDEX idx_pipeline_runs_unsettled ON pipeline_runs (project_id, created_at) WHERE settled_at IS NULL;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE pipeline_stage_runs (
    run_id         TEXT NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
    project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    stage_id       TEXT NOT NULL,
    outcome        TEXT NOT NULL,
    attempt        INTEGER NOT NULL DEFAULT 0,
    entered_via    TEXT NOT NULL DEFAULT '',
    prev_stage     TEXT NOT NULL DEFAULT '',
    failed_stage   TEXT NOT NULL DEFAULT '',
    failed_outcome TEXT NOT NULL DEFAULT '',
    session_id     TEXT NOT NULL DEFAULT '',
    workspace_kind TEXT NOT NULL DEFAULT '',
    workspace_path TEXT NOT NULL DEFAULT '',
    -- Nullable rather than zero-defaulted: a stage that has not started has no
    -- deadline yet, and a zero time is not the same statement.
    deadline_at    TIMESTAMP,
    started_at     TIMESTAMP,
    settled_at     TIMESTAMP,
    reason         TEXT NOT NULL DEFAULT '',
    output_tail    TEXT NOT NULL DEFAULT '',
    -- RunState.Nudged, stored where it belongs: one nudge per stage, ever.
    nudged         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, stage_id)
);
-- +goose StatementEnd

-- +goose StatementBegin
-- Append-only. The engine's SignalReader takes the newest row per (run, stage),
-- so a post-nudge signal supersedes the first without losing it.
CREATE TABLE pipeline_stage_signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
    stage_id   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('done', 'fail')),
    reason     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_pipeline_stage_signals_stage ON pipeline_stage_signals (run_id, stage_id, created_at DESC, id DESC);
-- +goose StatementEnd

-- +goose StatementBegin
-- env_json is a JSON object of environment variables injected into a command
-- stage's process at exec time. Same trust level as the gh token already on
-- disk: no UI editor, no read path that echoes a value back.
CREATE TABLE pipeline_credentials (
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    env_json   TEXT NOT NULL CHECK (json_valid(env_json)),
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (project_id, name)
);
-- +goose StatementEnd

-- Pipeline CDC triggers. All pipeline events are project-level (session_id
-- NULL) because a run's session id may be absent or may not be a sessions row.

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
            'status', NEW.status,
            'subjectKind', NEW.subject_kind,
            'sessionId', NEW.session_id,
            'prNumber', NEW.pr_number,
            'headSha', NEW.head_sha),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_runs_cdc_update
AFTER UPDATE ON pipeline_runs
WHEN OLD.status <> NEW.status
    OR OLD.updated_at <> NEW.updated_at
    OR OLD.cancel_reason <> NEW.cancel_reason
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_run_updated',
        json_object(
            'runId', NEW.id,
            'pipelineId', NEW.pipeline_id,
            'pipelineName', NEW.pipeline_name,
            'status', NEW.status,
            'subjectKind', NEW.subject_kind,
            'sessionId', NEW.session_id,
            'prNumber', NEW.pr_number,
            'headSha', NEW.head_sha),
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
            'stageId', NEW.stage_id,
            'outcome', NEW.outcome,
            'attempt', NEW.attempt,
            'sessionId', NEW.session_id),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER pipeline_stage_runs_cdc_update
AFTER UPDATE ON pipeline_stage_runs
WHEN OLD.outcome <> NEW.outcome
    OR OLD.attempt <> NEW.attempt
    OR OLD.session_id <> NEW.session_id
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_stage_run_updated',
        json_object(
            'runId', NEW.run_id,
            'stageId', NEW.stage_id,
            'outcome', NEW.outcome,
            'attempt', NEW.attempt,
            'sessionId', NEW.session_id),
        datetime('now'));
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS pipeline_stage_runs_cdc_update;
DROP TRIGGER IF EXISTS pipeline_stage_runs_cdc_insert;
DROP TRIGGER IF EXISTS pipeline_runs_cdc_update;
DROP TRIGGER IF EXISTS pipeline_runs_cdc_insert;
DROP INDEX IF EXISTS idx_pipeline_stage_signals_stage;
DROP INDEX IF EXISTS idx_pipeline_runs_unsettled;
DROP INDEX IF EXISTS idx_pipeline_runs_project_created;
DROP TABLE IF EXISTS pipeline_credentials;
DROP TABLE IF EXISTS pipeline_stage_signals;
DROP TABLE IF EXISTS pipeline_stage_runs;
DROP TABLE IF EXISTS pipeline_runs;
-- +goose StatementEnd

-- Recreate the v1 tables and their triggers as 0040 through 0046 left them, so
-- a down migration lands on the schema those migrations describe. The rows are
-- gone either way: the up migration dropped them.
-- +goose StatementBegin
CREATE TABLE pipeline_runs (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
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
    updated_at         TIMESTAMP NOT NULL,
    context_json       TEXT NOT NULL DEFAULT '{}',
    blocks_merge       INTEGER NOT NULL DEFAULT 0
);
-- +goose StatementEnd

-- +goose StatementBegin
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
    session_id    TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    output        TEXT NOT NULL DEFAULT '',
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
    status           TEXT NOT NULL DEFAULT 'open',
    sent_to_agent_at TIMESTAMP,
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
