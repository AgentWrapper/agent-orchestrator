-- +goose Up
CREATE INDEX idx_model_usage_events_usage_source ON model_usage_events (usage_source_id);
CREATE INDEX idx_usage_sources_codex_native_latest
    ON usage_sources (kind, native_session_id, binding_id, generation DESC, id DESC);

-- +goose Down
DROP INDEX idx_usage_sources_codex_native_latest;
DROP INDEX idx_model_usage_events_usage_source;
