-- +goose Up
-- +goose StatementBegin
-- The worker_idle outbox existed only to nudge the project orchestrator when a
-- worker went idle. That nudge is gone (idle does not mean done, it re-fired for
-- the same worker, and the human already sees idle state in the UI), so the
-- outbox has no remaining consumer. Idle DETECTION stays on the session row.
DROP INDEX IF EXISTS idx_worker_idle_pending_project;
DROP INDEX IF EXISTS idx_worker_idle_pending_worker;
DROP TABLE IF EXISTS worker_idle_events;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE TABLE worker_idle_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    transition_at TIMESTAMP NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivered')),
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX idx_worker_idle_pending_worker
    ON worker_idle_events(worker_id)
    WHERE delivery_state = 'pending';

CREATE INDEX idx_worker_idle_pending_project
    ON worker_idle_events(project_id)
    WHERE delivery_state = 'pending';
-- +goose StatementEnd
