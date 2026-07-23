-- name: GetPendingWorkerIdleEventByWorker :one
SELECT *
FROM worker_idle_events
WHERE worker_id = ? AND delivery_state = 'pending'
LIMIT 1;

-- name: InsertWorkerIdleEvent :exec
INSERT INTO worker_idle_events (
    id, project_id, worker_id, transition_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?);

-- name: TouchWorkerIdleEvent :exec
UPDATE worker_idle_events
SET transition_at = ?, updated_at = ?
WHERE id = ?;

-- name: ListPendingWorkerIdleEventsByProject :many
SELECT *
FROM worker_idle_events
WHERE project_id = ? AND delivery_state = 'pending'
ORDER BY transition_at ASC;

-- name: ListPendingWorkerIdleEvents :many
SELECT *
FROM worker_idle_events
WHERE delivery_state = 'pending'
ORDER BY transition_at ASC;

-- name: MarkWorkerIdleEventDelivered :exec
UPDATE worker_idle_events
SET delivery_state = 'delivered', updated_at = ?
WHERE id = ?;
