-- +goose Up
-- run_number is the per-pipeline counter humans refer to a run by ("inform #3
-- failed"), the way GitHub Actions numbers workflow runs. It is allocated in
-- the INSERT that creates the run (see UpsertPipelineRun) and never rewritten,
-- so a number, once shown, always means the same run.
--
-- The counter is scoped to (project_id, pipeline_name), not to pipeline_id: a
-- definition that is deleted and recreated gets a fresh id but keeps its name,
-- and its old runs stay in the table and in their run folders. Scoping by name
-- means the recreated definition continues from where the old one stopped
-- instead of handing out numbers that already appear in an older run's
-- run.json. A rename starts a fresh sequence, which is safe because the new
-- name has no runs behind it.
-- +goose StatementBegin
ALTER TABLE pipeline_runs ADD COLUMN run_number INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose StatementBegin
-- Backfill the runs that predate the counter, oldest first, so existing runs
-- read in the same order the list already shows them in.
UPDATE pipeline_runs SET run_number = (
    SELECT ranked.n FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY project_id, pipeline_name ORDER BY created_at, id
        ) AS n
        FROM pipeline_runs
    ) AS ranked
    WHERE ranked.id = pipeline_runs.id
);
-- +goose StatementEnd

-- +goose StatementBegin
-- The allocation is a MAX(...)+1 subquery inside the insert, which is atomic
-- within its statement; this index is what makes a duplicate impossible rather
-- than merely unlikely, so two racing triggers for one pipeline can never end
-- up both called #4.
CREATE UNIQUE INDEX idx_pipeline_runs_number ON pipeline_runs (project_id, pipeline_name, run_number);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_pipeline_runs_number;
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE pipeline_runs DROP COLUMN run_number;
-- +goose StatementEnd
