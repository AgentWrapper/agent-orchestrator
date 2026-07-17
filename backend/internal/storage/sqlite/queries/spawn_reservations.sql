-- name: NextSpawnNum :one
SELECT COALESCE(MAX(nums.num), 0) + 1 AS next FROM (
    SELECT num FROM sessions WHERE sessions.project_id = ?
    UNION ALL
    SELECT num FROM spawn_reservations WHERE spawn_reservations.project_id = ?
) AS nums;

-- name: GetSpawnReservationByRequestID :one
SELECT request_id, generation, session_id, project_id, num, state, created_at
FROM spawn_reservations WHERE project_id = ? AND request_id = ?;

-- name: InsertSpawnReservation :exec
INSERT INTO spawn_reservations (request_id, generation, session_id, project_id, num, state, created_at)
VALUES (?, ?, ?, ?, ?, 'launching', ?);

-- name: MarkSpawnReservationCommitted :execrows
UPDATE spawn_reservations SET state = 'spawned'
WHERE generation = ? AND state = 'launching';

-- name: DeleteSpawnReservation :execrows
DELETE FROM spawn_reservations WHERE generation = ? AND state = 'launching';

-- name: DeleteCommittedSpawnSession :execrows
DELETE FROM sessions WHERE generation = ? AND spawn_state = 'spawned';

-- name: DeleteCommittedSpawnReservation :execrows
DELETE FROM spawn_reservations WHERE generation = ? AND state = 'spawned';
