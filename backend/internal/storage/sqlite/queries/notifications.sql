-- name: CreateNotification :one
INSERT INTO notifications (
    id, session_id, project_id, pr_url, type, title, body, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ListUnreadNotificationsPage :many
SELECT *
FROM notifications
WHERE status = 'unread'
  AND (
    CAST(sqlc.arg(before_id) AS TEXT) = ''
    OR created_at < sqlc.arg(before_created_at)
    OR (created_at = sqlc.arg(before_created_at) AND id < CAST(sqlc.arg(before_id) AS TEXT))
  )
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListNotificationsPage :many
SELECT *
FROM notifications
WHERE (
    CAST(sqlc.arg(before_id) AS TEXT) = ''
    OR created_at < sqlc.arg(before_created_at)
    OR (created_at = sqlc.arg(before_created_at) AND id < CAST(sqlc.arg(before_id) AS TEXT))
  )
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: CountUnreadNotifications :one
SELECT COUNT(*)
FROM notifications
WHERE status = 'unread';

-- name: MarkNotificationRead :one
UPDATE notifications
SET status = 'read'
WHERE id = ? AND status = 'unread'
RETURNING *;

-- name: MarkAllNotificationsRead :execrows
UPDATE notifications
SET status = 'read'
WHERE status = 'unread';

-- name: GetUnreadNotificationByDedupe :one
SELECT *
FROM notifications
WHERE session_id = ? AND type = ? AND pr_url = ? AND status = 'unread'
LIMIT 1;
