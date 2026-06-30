-- name: UpsertPRReview :exec
INSERT INTO pr_reviews (pr_url, review_id, author, state, url, is_bot, submitted_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (pr_url, review_id) DO UPDATE SET
    author = excluded.author,
    state = excluded.state,
    url = excluded.url,
    is_bot = excluded.is_bot,
    submitted_at = excluded.submitted_at;

-- name: DeletePRReviews :exec
DELETE FROM pr_reviews WHERE pr_url = ?;

-- name: ListPRReviews :many
SELECT pr_url, review_id, author, state, url, is_bot, submitted_at
FROM pr_reviews WHERE pr_url = ? ORDER BY submitted_at, review_id;
