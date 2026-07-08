-- name: CreateNotification :one
INSERT INTO notifications (
    id, session_id, project_id, pr_url, type, title, body, sensitive, changed_paths, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
WHERE session_id = ? AND type = ? AND pr_url = ? AND sensitive = ? AND status = 'unread'
LIMIT 1;
