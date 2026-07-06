-- Review runs are PR-scoped. Two PRs in one worker session can legitimately
-- share a head SHA, so the idempotency index must include pr_url. Completed
-- changes_requested runs are intentionally excluded so the same head can be
-- reviewed again after the worker applies feedback. Runs created by one trigger
-- also share batch_id so one reviewer CLI submission can notify the worker about
-- multiple PRs at once.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review_run ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose StatementBegin
DROP INDEX idx_review_run_session_sha;
-- +goose StatementEnd

-- +goose StatementBegin
DELETE FROM review_run
WHERE target_sha != ''
  AND pr_url != ''
  AND status != 'failed'
  AND verdict != 'changes_requested'
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
      WHERE target_sha != '' AND pr_url != '' AND status != 'failed' AND verdict != 'changes_requested'
    )
    WHERE rn = 1
  );
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha
    ON review_run (session_id, pr_url, target_sha)
    WHERE target_sha != '' AND status != 'failed' AND verdict != 'changes_requested';
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_review_run_session_batch
    ON review_run (session_id, batch_id, created_at)
    WHERE batch_id != '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_review_run_session_batch;
-- +goose StatementEnd

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

-- +goose StatementBegin
ALTER TABLE review_run DROP COLUMN batch_id;
-- +goose StatementEnd
