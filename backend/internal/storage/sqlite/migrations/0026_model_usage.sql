-- +goose Up
-- +goose StatementBegin

CREATE TABLE usage_bindings (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    harness            TEXT NOT NULL
        CHECK (harness IN ('claude-code', 'codex')),
    native_root_id     TEXT NOT NULL CHECK (trim(native_root_id) <> ''),
    initial_model_id   TEXT NOT NULL DEFAULT '',
    source_cli_version TEXT NOT NULL DEFAULT '',
    state              TEXT NOT NULL
        CHECK (state IN ('discovering', 'active', 'finalizing', 'complete', 'partial')),
    last_error_code    TEXT NOT NULL DEFAULT '',
    first_seen_at      TIMESTAMP NOT NULL,
    last_seen_at       TIMESTAMP NOT NULL,
    updated_at         TIMESTAMP NOT NULL,

    UNIQUE (session_id, harness, native_root_id)
);
CREATE INDEX idx_usage_bindings_session_state ON usage_bindings (session_id, state);

CREATE TABLE usage_sources (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id                    INTEGER NOT NULL REFERENCES usage_bindings (id) ON DELETE CASCADE,
    kind                          TEXT NOT NULL
        CHECK (kind IN ('claude_main', 'claude_subagent', 'codex_rollout')),
    native_session_id             TEXT NOT NULL DEFAULT '',
    subagent_id                   TEXT NOT NULL DEFAULT '',
    artifact_path                 TEXT NOT NULL CHECK (trim(artifact_path) <> ''),
    file_identity                 TEXT NOT NULL DEFAULT '',
    generation                    INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    byte_offset                   INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
    baseline_input_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (baseline_input_tokens >= 0),
    baseline_cached_input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (baseline_cached_input_tokens >= 0),
    baseline_cache_write_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (baseline_cache_write_tokens >= 0),
    baseline_output_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (baseline_output_tokens >= 0),
    baseline_reasoning_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (baseline_reasoning_tokens >= 0),
    parser_version                TEXT NOT NULL CHECK (trim(parser_version) <> ''),
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
CREATE INDEX idx_usage_sources_state_retry ON usage_sources (state, next_retry_at);
CREATE INDEX idx_usage_sources_binding_kind ON usage_sources (binding_id, kind);

CREATE TABLE model_usage_events (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    binding_id              INTEGER NOT NULL REFERENCES usage_bindings (id) ON DELETE CASCADE,
    usage_source_id         INTEGER NOT NULL REFERENCES usage_sources (id) ON DELETE CASCADE,
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
    cache_write_5m_tokens   INTEGER CHECK (cache_write_5m_tokens IS NULL OR (cache_write_5m_tokens >= 0 AND cache_write_5m_tokens <= cache_write_tokens)),
    cache_write_1h_tokens   INTEGER CHECK (cache_write_1h_tokens IS NULL OR (cache_write_1h_tokens >= 0 AND cache_write_1h_tokens <= cache_write_tokens)),
    output_tokens           INTEGER NOT NULL CHECK (output_tokens >= 0),
    reasoning_tokens        INTEGER CHECK (reasoning_tokens IS NULL OR (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)),
    duration_ms             INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    reported_cost_nanos     INTEGER CHECK (reported_cost_nanos IS NULL OR reported_cost_nanos >= 0),
    estimated_cost_nanos    INTEGER CHECK (estimated_cost_nanos IS NULL OR estimated_cost_nanos >= 0),
    pricing_version         TEXT NOT NULL DEFAULT '',
    cost_basis              TEXT NOT NULL
        CHECK (cost_basis IN ('provider_reported', 'api_pricing_estimate', 'unavailable')),
    token_confidence        TEXT NOT NULL
        CHECK (token_confidence IN ('provider_reported', 'parsed_jsonl', 'unavailable')),
    cost_confidence         TEXT NOT NULL
        CHECK (cost_confidence IN ('provider_reported', 'api_pricing_estimate', 'unavailable')),
    source_event_key        TEXT NOT NULL CHECK (trim(source_event_key) <> ''),
    source_usage_hash       TEXT NOT NULL CHECK (trim(source_usage_hash) <> ''),
    parser_version          TEXT NOT NULL CHECK (trim(parser_version) <> ''),
    source_cli_version      TEXT NOT NULL DEFAULT '',
    created_at              TIMESTAMP NOT NULL,

    UNIQUE (binding_id, source_event_key)
);
CREATE INDEX idx_model_usage_events_session_observed ON model_usage_events (session_id, observed_at);
CREATE INDEX idx_model_usage_events_project_observed ON model_usage_events (project_id, observed_at);
CREATE INDEX idx_model_usage_events_session_model ON model_usage_events (session_id, harness, provider, model_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE model_usage_events;
DROP TABLE usage_sources;
DROP TABLE usage_bindings;
-- +goose StatementEnd
