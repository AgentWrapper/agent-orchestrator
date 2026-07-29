-- +goose Up
CREATE INDEX idx_model_usage_events_usage_source ON model_usage_events (usage_source_id);

-- +goose Down
DROP INDEX idx_model_usage_events_usage_source;
