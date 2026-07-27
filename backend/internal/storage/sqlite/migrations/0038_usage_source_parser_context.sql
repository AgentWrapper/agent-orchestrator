-- +goose Up
ALTER TABLE usage_sources ADD COLUMN current_model_id TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_sources ADD COLUMN current_provider TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE usage_sources DROP COLUMN current_provider;
ALTER TABLE usage_sources DROP COLUMN current_model_id;
