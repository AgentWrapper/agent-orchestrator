-- name: CreateNotification :one
INSERT INTO notifications (
    id, session_id, project_id, pr_url, type, title, body, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ListRecentUnreadNotifications :many
SELECT *
FROM notifications
WHERE status = 'unread' AND created_at >= ?
ORDER BY created_at DESC
LIMIT ?;

-- name: ListRecentNotifications :many
SELECT *
FROM notifications
WHERE created_at >= ?
ORDER BY created_at DESC
LIMIT ?;

-- name: DeleteNotificationsBefore :exec
DELETE FROM notifications
WHERE created_at < ?;

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
WHERE session_id = ? AND type = ? AND pr_url = ? AND status = 'unread'
LIMIT 1;
