-- +goose Up
ALTER TABLE ao_worker_connections
    ADD COLUMN ready_at TIMESTAMPTZ;

-- Existing connections predate the bootstrap/readiness distinction and were
-- already treated as ready by the control plane.
UPDATE ao_worker_connections
SET ready_at = last_seen_at;

-- +goose Down
ALTER TABLE ao_worker_connections
    DROP COLUMN ready_at;
