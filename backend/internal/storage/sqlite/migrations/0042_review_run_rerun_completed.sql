-- Reviewer lifecycle/restore support:
-- - persist the reviewer's native agent session id so restored reviewer
--   terminals can resume the original conversation
-- - allow explicit review triggers to re-run a PR head that already has a
--   completed AO review, while keeping the uniqueness guard for running work

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review ADD COLUMN agent_session_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha;
-- +goose StatementEnd

-- +goose StatementBegin
DELETE FROM review_run
WHERE target_sha != ''
  AND status NOT IN ('failed', 'cancelled')
  AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'))
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
      WHERE target_sha != ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'))
    )
    WHERE rn = 1
  );
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha
    ON review_run (session_id, pr_url, target_sha)
    WHERE target_sha != ''
        AND status = 'running'
        AND verdict = '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha
    ON review_run (session_id, pr_url, target_sha)
    WHERE target_sha != ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'));
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE review DROP COLUMN agent_session_id;
-- +goose StatementEnd
