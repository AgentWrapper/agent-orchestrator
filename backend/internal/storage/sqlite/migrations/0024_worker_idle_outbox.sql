-- +goose Up
-- +goose StatementBegin
-- Outbox of worker completions awaiting delivery to a project orchestrator.
-- worker_id cascades deliberately: the event's only instruction is to inspect
-- that worker, so deleting the worker makes an undelivered completion obsolete
-- rather than something to keep retrying.
CREATE TABLE worker_idle_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    transition_at TIMESTAMP NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivered')),
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- One pending completion per worker: repeated idles coalesce onto a single row.
CREATE UNIQUE INDEX idx_worker_idle_pending_worker
    ON worker_idle_events(worker_id)
    WHERE delivery_state = 'pending';

CREATE INDEX idx_worker_idle_pending_project
    ON worker_idle_events(project_id)
    WHERE delivery_state = 'pending';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_worker_idle_pending_project;
DROP INDEX IF EXISTS idx_worker_idle_pending_worker;
DROP TABLE IF EXISTS worker_idle_events;
-- +goose StatementEnd
