-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
-- Earlier builds of this unmerged usage feature created wider tables. Rebuild
-- them from the durable columns shared by both layouts so existing development
-- databases can upgrade without losing collected token events.
PRAGMA foreign_keys=OFF;

CREATE TABLE usage_bindings_compact (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    harness            TEXT NOT NULL
        CHECK (harness IN ('claude-code', 'codex')),
    native_root_id     TEXT NOT NULL CHECK (trim(native_root_id) <> ''),
    initial_model_id   TEXT NOT NULL DEFAULT '',
    state              TEXT NOT NULL
        CHECK (state IN ('discovering', 'active', 'finalizing', 'complete', 'partial')),
    last_error_code    TEXT NOT NULL DEFAULT '',
    first_seen_at      TIMESTAMP NOT NULL,
    last_seen_at       TIMESTAMP NOT NULL,
    updated_at         TIMESTAMP NOT NULL,

    UNIQUE (session_id, harness, native_root_id)
);

CREATE TABLE usage_sources_compact (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id                    INTEGER NOT NULL REFERENCES usage_bindings_compact (id) ON DELETE CASCADE,
    kind                          TEXT NOT NULL
        CHECK (kind IN ('claude_main', 'claude_subagent', 'codex_rollout')),
    native_session_id             TEXT NOT NULL DEFAULT '',
    subagent_id                   TEXT NOT NULL DEFAULT '',
    artifact_path                 TEXT NOT NULL CHECK (trim(artifact_path) <> ''),
    file_identity                 TEXT NOT NULL DEFAULT '',
    generation                    INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    byte_offset                   INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
    parser_state_json             TEXT NOT NULL DEFAULT '{}',
    state                         TEXT NOT NULL
        CHECK (state IN ('pending', 'active', 'complete', 'error')),
    failure_count                 INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    anomaly_count                 INTEGER NOT NULL DEFAULT 0 CHECK (anomaly_count >= 0),
    next_retry_at                 TIMESTAMP,
    last_error_code               TEXT NOT NULL DEFAULT '',
    last_observed_at              TIMESTAMP,
    created_at                    TIMESTAMP NOT NULL,
    updated_at                    TIMESTAMP NOT NULL,

    UNIQUE (binding_id, artifact_path, generation)
);

CREATE TABLE model_usage_events_compact (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id              INTEGER NOT NULL REFERENCES usage_bindings_compact (id) ON DELETE CASCADE,
    usage_source_id         INTEGER NOT NULL REFERENCES usage_sources_compact (id) ON DELETE CASCADE,
    project_id              TEXT NOT NULL REFERENCES projects (id),
    session_id              TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    harness                 TEXT NOT NULL
        CHECK (harness IN ('claude-code', 'codex')),
    provider                TEXT NOT NULL DEFAULT '',
    model_id                TEXT NOT NULL CHECK (trim(model_id) <> ''),
    observed_at             TIMESTAMP NOT NULL,
    input_tokens            INTEGER NOT NULL CHECK (input_tokens >= 0),
    uncached_input_tokens   INTEGER NOT NULL CHECK (uncached_input_tokens >= 0 AND uncached_input_tokens <= input_tokens),
    cache_read_tokens       INTEGER NOT NULL CHECK (cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens),
    cache_write_tokens      INTEGER NOT NULL CHECK (cache_write_tokens >= 0 AND cache_write_tokens <= input_tokens),
    output_tokens           INTEGER NOT NULL CHECK (output_tokens >= 0),
    reasoning_tokens        INTEGER CHECK (reasoning_tokens IS NULL OR (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)),
    source_event_key        TEXT NOT NULL CHECK (trim(source_event_key) <> ''),
    created_at              TIMESTAMP NOT NULL,

    UNIQUE (binding_id, source_event_key)
);

INSERT INTO usage_bindings_compact (
    id, session_id, harness, native_root_id, initial_model_id, state,
    last_error_code, first_seen_at, last_seen_at, updated_at
)
SELECT
    id, session_id, harness, native_root_id, initial_model_id, state,
    last_error_code, first_seen_at, last_seen_at, updated_at
FROM usage_bindings;

INSERT INTO usage_sources_compact (
    id, binding_id, kind, native_session_id, subagent_id, artifact_path,
    file_identity, generation, byte_offset, parser_state_json, state,
    failure_count, anomaly_count, next_retry_at, last_error_code,
    last_observed_at, created_at, updated_at
)
SELECT
    id, binding_id, kind, native_session_id, subagent_id, artifact_path,
    file_identity, generation, byte_offset, parser_state_json, state,
    failure_count, anomaly_count, next_retry_at, last_error_code,
    last_observed_at, created_at, updated_at
FROM usage_sources
WHERE last_error_code <> 'artifact_replaced'
   OR EXISTS (
       SELECT 1
       FROM model_usage_events
       WHERE usage_source_id = usage_sources.id
   );

INSERT INTO model_usage_events_compact (
    id, binding_id, usage_source_id, project_id, session_id, harness,
    provider, model_id, observed_at, input_tokens, uncached_input_tokens,
    cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    source_event_key, created_at
)
SELECT
    id, binding_id, usage_source_id, project_id, session_id, harness,
    provider, model_id, observed_at, input_tokens, uncached_input_tokens,
    cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    source_event_key, created_at
FROM model_usage_events;

DROP TABLE model_usage_events;
DROP TABLE usage_sources;
DROP TABLE usage_bindings;

ALTER TABLE usage_bindings_compact RENAME TO usage_bindings;
ALTER TABLE usage_sources_compact RENAME TO usage_sources;
ALTER TABLE model_usage_events_compact RENAME TO model_usage_events;

CREATE INDEX idx_usage_bindings_session_state ON usage_bindings (session_id, state);
CREATE INDEX idx_usage_sources_state_retry ON usage_sources (state, next_retry_at);
CREATE INDEX idx_usage_sources_binding_kind ON usage_sources (binding_id, kind);
CREATE INDEX idx_model_usage_events_session_observed ON model_usage_events (session_id, observed_at);
CREATE INDEX idx_model_usage_events_project_observed ON model_usage_events (project_id, observed_at);
CREATE INDEX idx_model_usage_events_session_model ON model_usage_events (session_id, harness, provider, model_id);
CREATE INDEX idx_model_usage_events_usage_source ON model_usage_events (usage_source_id);
CREATE INDEX idx_usage_sources_codex_native_latest
    ON usage_sources (kind, native_session_id, binding_id, generation DESC, id DESC);

CREATE TRIGGER usage_bindings_cdc_insert
AFTER INSERT ON usage_bindings
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id,
        'session_updated',
        json_object('id', NEW.session_id),
        NEW.updated_at
    );
END;

CREATE TRIGGER usage_bindings_cdc_update
AFTER UPDATE ON usage_bindings
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id,
        'session_updated',
        json_object('id', NEW.session_id),
        NEW.updated_at
    );
END;

CREATE TRIGGER usage_sources_cdc_insert
AFTER INSERT ON usage_sources
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT
        sessions.project_id,
        usage_bindings.session_id,
        'session_updated',
        json_object('id', usage_bindings.session_id),
        NEW.updated_at
    FROM usage_bindings
    JOIN sessions ON sessions.id = usage_bindings.session_id
    WHERE usage_bindings.id = NEW.binding_id;
END;

CREATE TRIGGER usage_sources_cdc_update
AFTER UPDATE ON usage_sources
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT
        sessions.project_id,
        usage_bindings.session_id,
        'session_updated',
        json_object('id', usage_bindings.session_id),
        NEW.updated_at
    FROM usage_bindings
    JOIN sessions ON sessions.id = usage_bindings.session_id
    WHERE usage_bindings.id = NEW.binding_id;
END;

CREATE TRIGGER model_usage_events_cdc_insert
AFTER INSERT ON model_usage_events
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        NEW.project_id,
        NEW.session_id,
        'session_updated',
        json_object('id', NEW.session_id),
        NEW.created_at
    );
END;

PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
-- +goose StatementEnd

-- +goose Down
-- This migration removes redundant columns whose values are intentionally not
-- preserved, so restoring the wider development-only schema is not meaningful.
SELECT 1;
