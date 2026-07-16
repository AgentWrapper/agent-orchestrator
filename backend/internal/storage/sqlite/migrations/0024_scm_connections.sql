-- Summary: persist SCM connection metadata while keeping credential bytes in the OS vault.
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

CREATE TABLE scm_connections (
    id             TEXT PRIMARY KEY,
    provider       TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
    display_name   TEXT NOT NULL,
    web_base_url   TEXT NOT NULL,
    api_base_url   TEXT NOT NULL,
    credential_ref TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'connected', 'missing_credential', 'unauthorized', 'forbidden', 'unreachable', 'tls_error', 'rate_limited')),
    username        TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMP NOT NULL,
    updated_at     TIMESTAMP NOT NULL
);

-- Connection changes are global, so project_id becomes nullable. Existing
-- project/session/PR triggers continue to write their non-null project IDs.
CREATE TABLE change_log_new (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT REFERENCES projects (id),
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
            'scm_connection_created',
            'scm_connection_updated',
            'scm_connection_deleted'
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

-- Recreate every trigger that writes change_log. These are the definitions
-- active immediately before this migration (including preview revision CDC).
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

CREATE TRIGGER sessions_cdc_insert
AFTER INSERT ON sessions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_created',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END)),
        NEW.updated_at);
END;

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

CREATE TRIGGER pr_cdc_insert
AFTER INSERT ON pr
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_created',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;

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
CREATE TRIGGER scm_connections_cdc_insert
AFTER INSERT ON scm_connections
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NULL, NULL, 'scm_connection_created',
        json_object('id', NEW.id, 'provider', NEW.provider), NEW.created_at);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER scm_connections_cdc_update
AFTER UPDATE ON scm_connections
WHEN OLD.provider <> NEW.provider
    OR OLD.display_name <> NEW.display_name
    OR OLD.web_base_url <> NEW.web_base_url
    OR OLD.api_base_url <> NEW.api_base_url
    OR OLD.credential_ref <> NEW.credential_ref
    OR OLD.status <> NEW.status
    OR OLD.username <> NEW.username
    OR OLD.updated_at <> NEW.updated_at
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NULL, NULL, 'scm_connection_updated',
        json_object('id', NEW.id, 'provider', NEW.provider),
        CASE
            WHEN OLD.status <> NEW.status OR OLD.username <> NEW.username THEN datetime('now')
            ELSE NEW.updated_at
        END);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER scm_connections_cdc_delete
AFTER DELETE ON scm_connections
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NULL, NULL, 'scm_connection_deleted',
        json_object('id', OLD.id, 'provider', OLD.provider), datetime('now'));
END;
-- +goose StatementEnd

-- Explicit project connection references must resolve at commit time. Legacy
-- NULL, absent, and empty connection IDs remain valid.
-- +goose StatementBegin
CREATE TRIGGER projects_scm_connection_guard_insert
BEFORE INSERT ON projects
WHEN COALESCE(json_extract(NEW.config, '$.scm.connectionId'), '') <> ''
    AND NOT (
        json_extract(NEW.config, '$.scm.connectionId') = 'github-default'
        AND COALESCE(json_extract(NEW.config, '$.scm.provider'), 'github') = 'github'
    )
    AND NOT EXISTS (
        SELECT 1 FROM scm_connections
        WHERE id = json_extract(NEW.config, '$.scm.connectionId')
    )
BEGIN
    SELECT RAISE(ABORT, 'scm connection not found');
END;

CREATE TRIGGER projects_scm_connection_guard_update
BEFORE UPDATE OF config ON projects
WHEN COALESCE(json_extract(NEW.config, '$.scm.connectionId'), '') <> ''
    AND NOT (
        json_extract(NEW.config, '$.scm.connectionId') = 'github-default'
        AND COALESCE(json_extract(NEW.config, '$.scm.provider'), 'github') = 'github'
    )
    AND NOT EXISTS (
        SELECT 1 FROM scm_connections
        WHERE id = json_extract(NEW.config, '$.scm.connectionId')
    )
BEGIN
    SELECT RAISE(ABORT, 'scm connection not found');
END;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS projects_scm_connection_guard_update;
DROP TRIGGER IF EXISTS projects_scm_connection_guard_insert;
DROP TRIGGER IF EXISTS scm_connections_cdc_delete;
DROP TRIGGER IF EXISTS scm_connections_cdc_update;
DROP TRIGGER IF EXISTS scm_connections_cdc_insert;
DROP TRIGGER IF EXISTS pr_review_threads_cdc_update;
DROP TRIGGER IF EXISTS pr_review_threads_cdc_insert;
DROP TRIGGER IF EXISTS sessions_cdc_insert;
DROP TRIGGER IF EXISTS sessions_cdc_update;
DROP TRIGGER IF EXISTS pr_cdc_insert;
DROP TRIGGER IF EXISTS pr_cdc_update;
DROP TRIGGER IF EXISTS pr_session_cdc_update;
DROP TRIGGER IF EXISTS pr_checks_cdc_insert;
DROP TRIGGER IF EXISTS pr_checks_cdc_update;
DROP TABLE IF EXISTS scm_connections;

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
WHERE project_id IS NOT NULL
  AND event_type IN (
      'session_created',
      'session_updated',
      'pr_created',
      'pr_updated',
      'pr_check_recorded',
      'pr_session_changed',
      'pr_review_thread_added',
      'pr_review_thread_resolved'
  );

DROP INDEX IF EXISTS idx_change_log_project;
DROP TABLE change_log;
ALTER TABLE change_log_old RENAME TO change_log;
CREATE INDEX idx_change_log_project ON change_log (project_id, seq);
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

CREATE TRIGGER sessions_cdc_insert
AFTER INSERT ON sessions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_created',
        json_object('id', NEW.id, 'activity', NEW.activity_state, 'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END)),
        NEW.updated_at);
END;

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

CREATE TRIGGER pr_cdc_insert
AFTER INSERT ON pr
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id), NEW.session_id, 'pr_created',
        json_object('url', NEW.url, 'session', NEW.session_id, 'state', NEW.pr_state,
                    'ci', NEW.ci_state, 'review', NEW.review_decision, 'mergeability', NEW.mergeability),
        NEW.updated_at);
END;

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
