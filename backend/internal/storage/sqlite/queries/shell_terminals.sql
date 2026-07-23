-- name: InsertShellTerminal :one
INSERT INTO shell_terminals (
    handle_id, project_id, working_dir, title, app_run_id, created_at
) VALUES (?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: SelectShellTerminalByHandleID :one
SELECT *
FROM shell_terminals
WHERE handle_id = ?;

-- name: SelectShellTerminalsByAppRunID :many
SELECT *
FROM shell_terminals
WHERE app_run_id = ?
ORDER BY created_at;

-- name: SelectShellTerminalsFromPreviousAppRuns :many
SELECT *
FROM shell_terminals
WHERE app_run_id <> ?
ORDER BY created_at;

-- name: DeleteShellTerminalByHandleID :execrows
DELETE FROM shell_terminals
WHERE handle_id = ?;

-- name: DeleteShellTerminalsFromPreviousAppRuns :execrows
DELETE FROM shell_terminals
WHERE app_run_id <> ?;
