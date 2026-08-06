-- Reviewer lifecycle/restore support:
-- - persist the reviewer's native agent session id so restored reviewer
--   terminals can resume the original conversation
-- - keep duplicate protection per PR target SHA/harness for running or terminal
--   non-changes-requested review runs, while preserving changes_requested retry
--   behavior

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review ADD COLUMN agent_session_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE review_session (
    session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    harness            TEXT NOT NULL,
    reviewer_handle_id TEXT NOT NULL DEFAULT '',
    agent_session_id   TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, harness)
);
-- +goose StatementEnd

-- +goose StatementBegin
INSERT INTO review_session (session_id, project_id, harness, reviewer_handle_id, agent_session_id, created_at, updated_at)
SELECT session_id, project_id, harness, reviewer_handle_id, agent_session_id, created_at, updated_at
FROM review
WHERE harness != '';
-- +goose StatementEnd

-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha_harness;
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
               PARTITION BY session_id, pr_url, target_sha, harness
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
CREATE UNIQUE INDEX idx_review_run_session_pr_sha_harness
    ON review_run (session_id, pr_url, target_sha, harness)
    WHERE target_sha != ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE review_session;
-- +goose StatementEnd

-- +goose StatementBegin
DROP INDEX idx_review_run_session_pr_sha_harness;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_review_run_session_pr_sha_harness
    ON review_run (session_id, pr_url, target_sha, harness)
    WHERE target_sha != ''
        AND status NOT IN ('failed', 'cancelled')
        AND (status = 'running' OR verdict NOT IN ('', 'changes_requested'));
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE review DROP COLUMN agent_session_id;
-- +goose StatementEnd
