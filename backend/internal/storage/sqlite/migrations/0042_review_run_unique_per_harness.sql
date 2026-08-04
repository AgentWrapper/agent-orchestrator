-- A reviewer choice is only meaningful if a different reviewer can actually run.
-- The idempotency key was (session_id, pr_url, target_sha), which treats a
-- second harness reviewing the same commit as a duplicate of the first, so
-- picking another agent silently reused the existing pass and no new review ever
-- happened. Harness joins the key: one pass per (worker, PR, commit, reviewer),
-- which still blocks the concurrent double-spawn the index exists for (#242),
-- because those race under the same harness.

-- +goose Up
ALTER TABLE sessions ADD COLUMN reviewer_harness TEXT NOT NULL DEFAULT '';

-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha_harness
    ON review_run (session_id, pr_url, target_sha, harness)
    WHERE target_sha != ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha_harness;
-- +goose StatementEnd

-- Collapse back to one row per commit before restoring the narrower key, or the
-- index would fail on rows this migration made legal. Keep a completed pass over
-- a running one, then the newest.
-- +goose StatementBegin
DELETE FROM review_run
WHERE target_sha != ''
  AND rowid NOT IN (
    SELECT rowid FROM (
      SELECT rowid,
             ROW_NUMBER() OVER (
               PARTITION BY session_id, pr_url, target_sha
               ORDER BY CASE status WHEN 'complete' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
                        created_at DESC,
                        rowid DESC
             ) AS rn
      FROM review_run
      WHERE target_sha != ''
    )
    WHERE rn = 1
  );
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha
    ON review_run (session_id, pr_url, target_sha)
    WHERE target_sha != ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'));
-- +goose StatementEnd

ALTER TABLE sessions DROP COLUMN reviewer_harness;
