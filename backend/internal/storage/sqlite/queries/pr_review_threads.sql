-- Summary: SQLC queries for replacing and reading normalized PR review threads.
-- name: UpsertPRReviewThread :exec
INSERT INTO pr_review_threads (pr_url, thread_id, review_id, path, line, resolved, is_bot, semantic_hash, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (pr_url, thread_id) DO UPDATE SET
    review_id = excluded.review_id,
    path = excluded.path,
    line = excluded.line,
    resolved = excluded.resolved,
    is_bot = excluded.is_bot,
    semantic_hash = excluded.semantic_hash,
    updated_at = excluded.updated_at;

-- name: DeletePRReviewThreads :exec
DELETE FROM pr_review_threads WHERE pr_url = ?;

-- name: DeletePRReviewThread :exec
DELETE FROM pr_review_threads WHERE pr_url = ? AND thread_id = ?;

-- name: ListPRReviewThreads :many
SELECT pr_url, thread_id, review_id, path, line, resolved, is_bot, semantic_hash, updated_at
FROM pr_review_threads WHERE pr_url = ? ORDER BY updated_at, thread_id;

-- name: ListUnresolvedPRReviewThreadsByReview :many
SELECT pr_url, thread_id, review_id, path, line, resolved, is_bot, semantic_hash, updated_at
FROM pr_review_threads
WHERE pr_url = ? AND review_id = ? AND resolved = 0
ORDER BY updated_at, thread_id;
