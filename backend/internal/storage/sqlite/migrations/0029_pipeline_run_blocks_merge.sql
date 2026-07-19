-- Persist a pipeline run's terminal merge-blocking decision. ExitPredicates
-- .BlocksMerge and StagePolicy.BlocksMerge were parsed and editable but never
-- evaluated, stored, or consumed. The reducer now sets RunState.BlocksMerge when
-- a run reaches a terminal loop state, and the lifecycle merge-readiness path
-- consults the most recent settled run for a PR. Store it as an integer bool;
-- legacy rows default to 0 (does not block), which is the safe no-opinion value.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE pipeline_runs ADD COLUMN blocks_merge INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pipeline_runs DROP COLUMN blocks_merge;
-- +goose StatementEnd
