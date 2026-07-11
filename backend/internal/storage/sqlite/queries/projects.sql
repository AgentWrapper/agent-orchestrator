-- name: UpsertProject :exec
-- Note: `paused` is intentionally omitted. Pause state is independent of config
-- and is mutated only by SetProjectPaused; a config save must never touch it.
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    path = excluded.path,
    repo_origin_url = excluded.repo_origin_url,
    display_name = excluded.display_name,
    archived_at = excluded.archived_at,
    config = excluded.config,
    kind = excluded.kind;

-- name: GetProject :one
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, paused
FROM projects WHERE id = ?;

-- name: ListProjects :many
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, paused
FROM projects WHERE archived_at IS NULL ORDER BY id;

-- name: FindProjectByPath :one
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, paused
FROM projects WHERE path = ? AND archived_at IS NULL;

-- name: ArchiveProject :execrows
UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL;

-- name: SetProjectPaused :execrows
UPDATE projects SET paused = ? WHERE id = ?;
