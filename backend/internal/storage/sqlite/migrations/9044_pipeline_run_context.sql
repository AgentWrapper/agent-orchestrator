-- Persist a pipeline run's RunContext (PR identity, issue id, session facts).
-- PR #275 added RunContext to the in-memory RunState and threaded it to stage
-- executors, but never persisted it, so a daemon restart rehydrated every run
-- with an empty context. Per-PR loop keys (issue #270) derive from Context.PRURL,
-- so without this column a restart collapses sibling PR runs back onto the shared
-- session+pipeline key. Store the context as JSON; legacy rows default to '{}',
-- which hydrates to the zero RunContext and degrades to the old key shape.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE pipeline_runs ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pipeline_runs DROP COLUMN context_json;
-- +goose StatementEnd
