-- Backstop SpawnOrchestrator(clean=false)'s idempotency with a database guard:
-- at most one non-terminated orchestrator row may exist per project.

-- +goose Up
-- +goose StatementBegin
UPDATE sessions
SET is_terminated = TRUE,
    activity_state = 'exited'
WHERE kind = 'orchestrator'
  AND is_terminated = FALSE
  AND rowid IN (
    SELECT rowid FROM (
      SELECT rowid,
             ROW_NUMBER() OVER (
               PARTITION BY project_id
               ORDER BY num DESC, created_at DESC, rowid DESC
             ) AS rn
      FROM sessions
      WHERE kind = 'orchestrator'
        AND is_terminated = FALSE
    )
    WHERE rn > 1
  );
-- +goose StatementEnd

-- +goose StatementBegin
CREATE UNIQUE INDEX idx_sessions_one_live_orchestrator_per_project
    ON sessions (project_id)
    WHERE kind = 'orchestrator' AND is_terminated = FALSE;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_sessions_one_live_orchestrator_per_project;
-- +goose StatementEnd
