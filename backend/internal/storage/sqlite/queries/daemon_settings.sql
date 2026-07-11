-- Daemon-global settings (single row, id = 1). Currently just the fleet-wide
-- pause switch; new daemon-global scalars go here rather than in a fresh table.

-- name: GetFleetPaused :one
SELECT fleet_paused FROM daemon_settings WHERE id = 1;

-- name: SetFleetPaused :exec
UPDATE daemon_settings SET fleet_paused = ? WHERE id = 1;
