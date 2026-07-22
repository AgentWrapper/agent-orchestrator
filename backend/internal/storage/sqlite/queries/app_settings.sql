-- name: GetAppSetting :one
SELECT value FROM app_settings WHERE key = ?;

-- name: SetAppSetting :exec
INSERT INTO app_settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
