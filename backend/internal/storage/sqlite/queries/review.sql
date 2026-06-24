-- name: UpsertReview :exec
INSERT INTO review (id, session_id, project_id, harness, pr_url, reviewer_handle_id, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id) DO UPDATE SET
    harness = excluded.harness,
    pr_url = excluded.pr_url,
    reviewer_handle_id = excluded.reviewer_handle_id,
    updated_at = excluded.updated_at;

-- name: GetReviewBySession :one
SELECT id, session_id, project_id, harness, pr_url, reviewer_handle_id, created_at, updated_at
FROM review WHERE session_id = ?;

-- name: InsertReviewRun :exec
INSERT INTO review_run (id, review_id, session_id, batch_id, harness, pr_url, target_sha, status, verdict, body, github_review_id, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateReviewRunResult :execrows
UPDATE review_run SET status = ?, verdict = ?, body = ?, github_review_id = ? WHERE id = ? AND status = 'running';

-- name: SupersedeReviewRun :execrows
UPDATE review_run SET status = 'failed', body = ? WHERE id = ? AND verdict = '' AND status != 'failed';

-- name: SupersedeStaleRunningReviewRuns :execrows
UPDATE review_run SET status = 'failed', body = ? WHERE session_id = ? AND pr_url = ? AND target_sha != ? AND status = 'running' AND verdict = '';

-- name: MarkReviewRunDelivered :execrows
UPDATE review_run SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'complete' AND delivered_at IS NULL;

-- name: GetReviewRun :one
SELECT id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at, github_review_id, delivered_at, batch_id
FROM review_run WHERE id = ?;

-- name: GetReviewRunBySessionPRAndSHA :one
SELECT id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at, github_review_id, delivered_at, batch_id
FROM review_run WHERE session_id = ? AND pr_url = ? AND target_sha = ? ORDER BY created_at DESC LIMIT 1;

-- name: ListReviewRunsBySession :many
SELECT id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at, github_review_id, delivered_at, batch_id
FROM review_run WHERE session_id = ? ORDER BY created_at DESC;

-- name: ListReviewRunsByBatch :many
SELECT id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at, github_review_id, delivered_at, batch_id
FROM review_run WHERE session_id = ? AND batch_id = ? ORDER BY created_at ASC, id ASC;
