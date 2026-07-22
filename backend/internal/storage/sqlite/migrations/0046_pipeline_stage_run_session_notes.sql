-- Persist per-stage session id, human notes, and captured output on
-- pipeline_stage_runs. StageState.SessionID (the agent session a stage ran in,
-- for run-detail click-through), StageState.Notes (fork-skip, findings-
-- truncated, exit-mode, unknown-fingerprint annotations), and StageState.Output
-- (command stdout+stderr tail) all round-trip through RunState but had no
-- columns, so the run detail served from the store lost them. Store notes as a
-- JSON array text; legacy rows default to empty, which renders as no session
-- link and no notes.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs ADD COLUMN notes TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs ADD COLUMN output TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs DROP COLUMN session_id;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs DROP COLUMN notes;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs DROP COLUMN output;
-- +goose StatementEnd
