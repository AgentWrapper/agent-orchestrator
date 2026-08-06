-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
-- Earlier revisions of the unmerged usage feature occupied migration versions
-- that now belong to shipped main migrations. Version 0052 is deliberately
-- beyond the known burned range. It installs the compact schema on clean
-- databases and rebuilds wider development tables without losing usage data.
-- NO TRANSACTION is required to toggle foreign_keys, while the explicit
-- BEGIN IMMEDIATE below still makes the entire compatibility rebuild atomic.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

-- Repair main migrations that old checkouts of this PR may have skipped after
-- recording the same version numbers for usage migrations.
UPDATE review_run SET batch_id = id WHERE batch_id = '';
CREATE TABLE IF NOT EXISTS agent_model_catalog (
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    binary_version TEXT NOT NULL DEFAULT '',
    catalog_json TEXT NOT NULL,
    source TEXT NOT NULL,
    fetched_at TIMESTAMP NOT NULL,
    PRIMARY KEY (agent_id, project_id)
);

DROP VIEW IF EXISTS usage_session_integrity;
DROP VIEW IF EXISTS usage_codex_pending_children;
DROP VIEW IF EXISTS usage_codex_source_discovery;
DROP TRIGGER IF EXISTS model_usage_events_cdc_insert;
DROP TRIGGER IF EXISTS usage_sources_cdc_update;
DROP TRIGGER IF EXISTS usage_sources_cdc_insert;
DROP TRIGGER IF EXISTS usage_bindings_cdc_update;
DROP TRIGGER IF EXISTS usage_bindings_cdc_insert;

-- These definitions make the rebuild work for both a clean database and an
-- earlier PR database. Existing wider tables are left untouched until their
-- common durable columns have been copied into the compact tables below.
CREATE TABLE IF NOT EXISTS usage_bindings (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    harness            TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
    native_root_id     TEXT NOT NULL CHECK (trim(native_root_id) <> ''),
    initial_model_id   TEXT NOT NULL DEFAULT '',
    state              TEXT NOT NULL CHECK (state IN ('discovering', 'active', 'finalizing', 'complete', 'partial')),
    last_error_code    TEXT NOT NULL DEFAULT '',
    updated_at         TIMESTAMP NOT NULL,
    UNIQUE (session_id, harness, native_root_id)
);

CREATE TABLE IF NOT EXISTS usage_sources (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id          INTEGER NOT NULL REFERENCES usage_bindings (id) ON DELETE CASCADE,
    kind                TEXT NOT NULL CHECK (kind IN ('claude_main', 'claude_subagent', 'codex_rollout')),
    native_session_id   TEXT NOT NULL DEFAULT '',
    subagent_id         TEXT NOT NULL DEFAULT '',
    artifact_path       TEXT NOT NULL CHECK (trim(artifact_path) <> ''),
    file_identity       TEXT NOT NULL DEFAULT '',
    generation          INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    byte_offset         INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
    parser_state_json   TEXT NOT NULL DEFAULT '{}',
    state               TEXT NOT NULL CHECK (state IN ('pending', 'active', 'complete', 'error')),
    failure_count       INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    anomaly_count       INTEGER NOT NULL DEFAULT 0 CHECK (anomaly_count >= 0),
    next_retry_at       TIMESTAMP,
    last_error_code     TEXT NOT NULL DEFAULT '',
    updated_at          TIMESTAMP NOT NULL,
    UNIQUE (binding_id, artifact_path, generation)
);

CREATE TABLE IF NOT EXISTS model_usage_events (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id              INTEGER NOT NULL REFERENCES usage_bindings (id) ON DELETE CASCADE,
    usage_source_id         INTEGER NOT NULL REFERENCES usage_sources (id) ON DELETE CASCADE,
    model_id                TEXT NOT NULL CHECK (trim(model_id) <> ''),
    input_tokens            INTEGER NOT NULL CHECK (input_tokens >= 0),
    uncached_input_tokens   INTEGER NOT NULL CHECK (uncached_input_tokens >= 0 AND uncached_input_tokens <= input_tokens),
    cache_read_tokens       INTEGER NOT NULL CHECK (cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens),
    cache_write_tokens      INTEGER NOT NULL CHECK (cache_write_tokens >= 0 AND cache_write_tokens <= input_tokens),
    output_tokens           INTEGER NOT NULL CHECK (output_tokens >= 0),
    reasoning_tokens        INTEGER CHECK (reasoning_tokens IS NULL OR (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)),
    source_event_key        TEXT NOT NULL CHECK (trim(source_event_key) <> ''),
    UNIQUE (binding_id, source_event_key)
);

CREATE TABLE usage_bindings_next (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    harness            TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
    native_root_id     TEXT NOT NULL CHECK (trim(native_root_id) <> ''),
    initial_model_id   TEXT NOT NULL DEFAULT '',
    state              TEXT NOT NULL CHECK (state IN ('discovering', 'active', 'finalizing', 'complete', 'partial')),
    last_error_code    TEXT NOT NULL DEFAULT '',
    updated_at         TIMESTAMP NOT NULL,
    UNIQUE (session_id, harness, native_root_id)
);

CREATE TABLE usage_sources_next (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id          INTEGER NOT NULL REFERENCES usage_bindings (id) ON DELETE CASCADE,
    kind                TEXT NOT NULL CHECK (kind IN ('claude_main', 'claude_subagent', 'codex_rollout')),
    native_session_id   TEXT NOT NULL DEFAULT '',
    subagent_id         TEXT NOT NULL DEFAULT '',
    artifact_path       TEXT NOT NULL CHECK (trim(artifact_path) <> ''),
    file_identity       TEXT NOT NULL DEFAULT '',
    generation          INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    byte_offset         INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
    parser_state_json   TEXT NOT NULL DEFAULT '{}',
    state               TEXT NOT NULL CHECK (state IN ('pending', 'active', 'complete', 'error')),
    failure_count       INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    anomaly_count       INTEGER NOT NULL DEFAULT 0 CHECK (anomaly_count >= 0),
    next_retry_at       TIMESTAMP,
    last_error_code     TEXT NOT NULL DEFAULT '',
    updated_at          TIMESTAMP NOT NULL,
    UNIQUE (binding_id, artifact_path, generation)
);

CREATE TABLE model_usage_events_next (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id              INTEGER NOT NULL REFERENCES usage_bindings (id) ON DELETE CASCADE,
    usage_source_id         INTEGER NOT NULL REFERENCES usage_sources (id) ON DELETE CASCADE,
    model_id                TEXT NOT NULL CHECK (trim(model_id) <> ''),
    input_tokens            INTEGER NOT NULL CHECK (input_tokens >= 0),
    uncached_input_tokens   INTEGER NOT NULL CHECK (uncached_input_tokens >= 0 AND uncached_input_tokens <= input_tokens),
    cache_read_tokens       INTEGER NOT NULL CHECK (cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens),
    cache_write_tokens      INTEGER NOT NULL CHECK (cache_write_tokens >= 0 AND cache_write_tokens <= input_tokens),
    output_tokens           INTEGER NOT NULL CHECK (output_tokens >= 0),
    reasoning_tokens        INTEGER CHECK (reasoning_tokens IS NULL OR (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)),
    source_event_key        TEXT NOT NULL CHECK (trim(source_event_key) <> ''),
    UNIQUE (binding_id, source_event_key)
);

INSERT INTO usage_bindings_next
SELECT id, session_id, harness, native_root_id, initial_model_id, state,
       last_error_code, updated_at
FROM usage_bindings;

INSERT INTO usage_sources_next
SELECT id, binding_id, kind, native_session_id, subagent_id, artifact_path,
       file_identity, generation, byte_offset, parser_state_json, state,
       failure_count, anomaly_count, next_retry_at, last_error_code, updated_at
FROM usage_sources;

INSERT INTO model_usage_events_next
SELECT id, binding_id, usage_source_id, model_id, input_tokens,
       uncached_input_tokens, cache_read_tokens, cache_write_tokens,
       output_tokens, reasoning_tokens, source_event_key
FROM model_usage_events;

DROP TABLE model_usage_events;
DROP TABLE usage_sources;
DROP TABLE usage_bindings;
ALTER TABLE usage_bindings_next RENAME TO usage_bindings;
ALTER TABLE usage_sources_next RENAME TO usage_sources;
ALTER TABLE model_usage_events_next RENAME TO model_usage_events;

CREATE INDEX idx_usage_bindings_session_state ON usage_bindings (session_id, state);
CREATE INDEX idx_usage_sources_state_retry ON usage_sources (state, next_retry_at);
CREATE INDEX idx_usage_sources_binding_kind ON usage_sources (binding_id, kind);
CREATE INDEX idx_usage_sources_codex_native_latest
    ON usage_sources (kind, native_session_id, binding_id, generation DESC, id DESC);
CREATE INDEX idx_model_usage_events_binding_model ON model_usage_events (binding_id, model_id);
CREATE INDEX idx_model_usage_events_usage_source ON model_usage_events (usage_source_id);

CREATE VIEW usage_codex_source_discovery AS
SELECT source_id, binding_id, native_session_id,
    CASE WHEN child_ids_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM json_each(child_ids_json) WHERE type <> 'text'
    ) THEN child_ids_json ELSE '[]' END AS discovered_child_ids_json,
    CASE WHEN child_ids_json IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(child_ids_json) WHERE type <> 'text'
    ) THEN 1 ELSE 0 END AS has_mixed_child_types
FROM (
    SELECT id AS source_id, binding_id, native_session_id,
        CASE WHEN json_valid(parser_state_json)
          AND json_type(parser_state_json, '$') = 'object'
          AND json_type(parser_state_json, '$.version') = 'integer'
          AND json_extract(parser_state_json, '$.version') = 1
          AND json_type(parser_state_json, '$.source_kind') = 'text'
          AND json_extract(parser_state_json, '$.source_kind') = 'codex_rollout'
          AND json_type(parser_state_json, '$.codex') = 'object'
          AND json_type(parser_state_json, '$.codex.discovered_child_ids') = 'array'
        THEN json_extract(parser_state_json, '$.codex.discovered_child_ids') END AS child_ids_json
    FROM usage_sources WHERE kind = 'codex_rollout'
);

CREATE VIEW usage_codex_pending_children AS
SELECT spawning.binding_id, CAST(discovered.value AS TEXT) AS native_session_id
FROM usage_codex_source_discovery spawning
JOIN json_each(spawning.discovered_child_ids_json) discovered
WHERE discovered.type = 'text'
  AND length(discovered.value) = 36
  AND substr(discovered.value, 9, 1) = '-'
  AND substr(discovered.value, 14, 1) = '-'
  AND substr(discovered.value, 19, 1) = '-'
  AND substr(discovered.value, 24, 1) = '-'
  AND lower(discovered.value) = discovered.value
  AND length(replace(discovered.value, '-', '')) = 32
  AND replace(discovered.value, '-', '') NOT GLOB '*[^0-9a-f]*'
  AND spawning.source_id = (
      SELECT latest.id FROM usage_sources latest
      WHERE latest.binding_id = spawning.binding_id
        AND latest.kind = 'codex_rollout'
        AND latest.native_session_id = spawning.native_session_id
      ORDER BY latest.generation DESC, latest.id DESC LIMIT 1
  )
  AND NOT EXISTS (
      SELECT 1 FROM usage_sources registered
      WHERE registered.binding_id = spawning.binding_id
        AND registered.kind = 'codex_rollout'
        AND registered.native_session_id = CAST(discovered.value AS TEXT)
  );

CREATE VIEW usage_session_integrity AS
SELECT ub.session_id,
    CAST(MAX(CASE
        WHEN ub.state = 'partial'
          OR ub.last_error_code NOT IN ('', 'source_discovery_pending', 'artifact_missing', 'source_read_failed')
          OR (us.last_error_code <> 'artifact_replaced' AND (
              us.anomaly_count > 0
              OR us.last_error_code NOT IN ('', 'source_discovery_pending', 'artifact_missing', 'source_read_failed')
          ))
        THEN 1 ELSE 0
    END) AS INTEGER) AS incomplete
FROM usage_bindings ub
LEFT JOIN usage_sources us ON us.binding_id = ub.id
GROUP BY ub.session_id;

CREATE TRIGGER usage_bindings_cdc_insert AFTER INSERT ON usage_bindings BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id),
            NEW.session_id, 'session_updated', json_object('id', NEW.session_id), NEW.updated_at);
END;
CREATE TRIGGER usage_bindings_cdc_update AFTER UPDATE ON usage_bindings BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES ((SELECT project_id FROM sessions WHERE id = NEW.session_id),
            NEW.session_id, 'session_updated', json_object('id', NEW.session_id), NEW.updated_at);
END;
CREATE TRIGGER usage_sources_cdc_update AFTER UPDATE ON usage_sources
WHEN OLD.anomaly_count IS NOT NEW.anomaly_count
  OR OLD.last_error_code IS NOT NEW.last_error_code
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, ub.session_id, 'session_updated', json_object('id', ub.session_id), NEW.updated_at
    FROM usage_bindings ub JOIN sessions s ON s.id = ub.session_id WHERE ub.id = NEW.binding_id;
END;

COMMIT;
PRAGMA foreign_keys=ON;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS usage_sources_cdc_update;
DROP TRIGGER IF EXISTS usage_bindings_cdc_update;
DROP TRIGGER IF EXISTS usage_bindings_cdc_insert;
DROP VIEW IF EXISTS usage_session_integrity;
DROP VIEW IF EXISTS usage_codex_pending_children;
DROP VIEW IF EXISTS usage_codex_source_discovery;
DROP TABLE IF EXISTS model_usage_events;
DROP TABLE IF EXISTS usage_sources;
DROP TABLE IF EXISTS usage_bindings;
-- +goose StatementEnd
