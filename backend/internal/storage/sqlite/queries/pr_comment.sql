-- name: InsertPRComment :exec
INSERT INTO pr_comment (pr_url, comment_id, author, file, line, body, resolved, created_at, thread_id, url, is_bot)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: InsertLegacyPRComment :exec
INSERT OR IGNORE INTO pr_comment (pr_url, comment_id, author, file, line, body, resolved, created_at, thread_id, url, is_bot)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: DeletePRComments :exec
DELETE FROM pr_comment WHERE pr_url = ?;

-- name: DeleteLegacyPRComments :exec
DELETE FROM pr_comment WHERE pr_url = ? AND thread_id = '';

-- name: DeletePRCommentsByThread :exec
DELETE FROM pr_comment WHERE pr_url = ? AND thread_id = ?;

-- name: ListPRComments :many
SELECT pr_url, comment_id, author, file, line, body, resolved, created_at, thread_id, url, is_bot
FROM pr_comment WHERE pr_url = ? ORDER BY created_at, comment_id;

-- name: ListPRCommentsByPRs :many
SELECT pr_url, comment_id, author, file, line, body, resolved, created_at, thread_id, url, is_bot
FROM pr_comment
WHERE pr_url IN (sqlc.slice('pr_urls'))
ORDER BY pr_url, created_at, comment_id;
