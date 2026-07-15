-- name: CreateSuggestion :one
INSERT INTO suggestions (
    id, project_id, title, note, priority, status, session_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ListSuggestions :many
SELECT *
FROM suggestions
WHERE project_id = ?
ORDER BY
    CASE status
        WHEN 'in_progress' THEN 0
        WHEN 'backlog' THEN 1
        WHEN 'done' THEN 2
        ELSE 3
    END,
    CASE priority
        WHEN 'important' THEN 0
        WHEN 'normal' THEN 1
        ELSE 2
    END,
    updated_at DESC;

-- name: GetSuggestion :one
SELECT *
FROM suggestions
WHERE project_id = ? AND id = ?
LIMIT 1;

-- name: UpdateSuggestion :one
UPDATE suggestions
SET title = ?, note = ?, priority = ?, status = ?, session_id = ?, updated_at = ?
WHERE project_id = ? AND id = ?
RETURNING *;
