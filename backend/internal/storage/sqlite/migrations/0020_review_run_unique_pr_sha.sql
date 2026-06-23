-- Review runs are PR-scoped. Two PRs in one worker session can legitimately
-- share a head SHA, so the idempotency index must include pr_url.

-- +goose Up
-- +goose StatementBegin
DROP INDEX idx_review_run_session_sha;
-- +goose StatementEnd

-- +goose StatementBegin
DELETE FROM review_run
WHERE target_sha != ''
  AND pr_url != ''
  AND status != 'failed'
  AND rowid NOT IN (
    SELECT rowid FROM (
      SELECT rowid,
             ROW_NUMBER() OVER (
               PARTITION BY session_id, pr_url, target_sha
               ORDER BY CASE status WHEN 'complete' THEN 0 WHEN 'delivered' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
                        created_at DESC,
                        rowid DESC
             ) AS rn
      FROM review_run
      WHERE target_sha != '' AND pr_url != '' AND status != 'failed'
    )
    WHERE rn = 1
  );
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha
    ON review_run (session_id, pr_url, target_sha)
    WHERE target_sha != '' AND status != 'failed';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha;
-- +goose StatementEnd

-- +goose StatementBegin
DELETE FROM review_run
WHERE target_sha != ''
  AND status != 'failed'
  AND rowid NOT IN (
    SELECT rowid FROM (
      SELECT rowid,
             ROW_NUMBER() OVER (
               PARTITION BY session_id, target_sha
               ORDER BY CASE status WHEN 'complete' THEN 0 WHEN 'delivered' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
                        created_at DESC,
                        rowid DESC
             ) AS rn
      FROM review_run
      WHERE target_sha != '' AND status != 'failed'
    )
    WHERE rn = 1
  );
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_sha
    ON review_run (session_id, target_sha)
    WHERE target_sha != '' AND status != 'failed';
-- +goose StatementEnd
