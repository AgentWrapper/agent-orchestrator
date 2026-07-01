-- name: UpsertCollision :exec
-- Insert or refresh one ordered session pair. first_seen_at is preserved across
-- updates so the dashboard can show how long an overlap has persisted; only
-- severity/files/signature/updated_at move when the overlap content changes.
INSERT INTO session_collision (
    project_id, session_a, session_b, severity, files, signature, first_seen_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_a, session_b) DO UPDATE SET
    project_id = excluded.project_id,
    severity   = excluded.severity,
    files      = excluded.files,
    signature  = excluded.signature,
    updated_at = excluded.updated_at;

-- name: DeleteCollision :exec
DELETE FROM session_collision WHERE session_a = ? AND session_b = ?;

-- name: ListCollisionsByProject :many
SELECT project_id, session_a, session_b, severity, files, signature, first_seen_at, updated_at
FROM session_collision
WHERE project_id = ?
ORDER BY session_a, session_b;

-- name: ListAllCollisions :many
SELECT project_id, session_a, session_b, severity, files, signature, first_seen_at, updated_at
FROM session_collision
ORDER BY project_id, session_a, session_b;

-- name: ListCollisionsForSession :many
SELECT project_id, session_a, session_b, severity, files, signature, first_seen_at, updated_at
FROM session_collision
WHERE session_a = ? OR session_b = ?
ORDER BY session_a, session_b;
