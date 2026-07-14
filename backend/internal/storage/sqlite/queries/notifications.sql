-- name: CreateNotification :one
INSERT INTO notifications (
    id, session_id, project_id, pr_url, type, subject_kind, subject_id, title, body, sensitive, changed_paths, head_sha, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ListUnreadNotifications :many
SELECT *
FROM notifications
WHERE status = 'unread'
ORDER BY created_at DESC
LIMIT ?;

-- name: MarkNotificationRead :one
UPDATE notifications
SET status = 'read'
WHERE id = ? AND status = 'unread'
RETURNING *;

-- name: MarkAllNotificationsRead :many
UPDATE notifications
SET status = 'read'
WHERE status = 'unread'
RETURNING *;

-- name: GetUnreadNotificationByDedupe :one
SELECT *
FROM notifications
WHERE subject_kind = ? AND COALESCE(NULLIF(subject_id, ''), session_id) = ? AND type = ? AND pr_url = ? AND sensitive = ? AND head_sha = ? AND status = 'unread'
LIMIT 1;

-- name: GetWorkerTerminalNotificationByDedupe :one
SELECT *
FROM notifications
WHERE subject_kind = ?
  AND COALESCE(NULLIF(subject_id, ''), session_id) = ?
  AND type = ?
  AND type = 'worker_died_unfinished'
  AND body = ?
LIMIT 1;
