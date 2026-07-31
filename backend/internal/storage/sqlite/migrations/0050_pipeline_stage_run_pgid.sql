-- +goose Up
-- pgid is the OS process group a command stage was launched in. The engine's
-- handle on that process dies with the daemon, so a restart could settle the
-- stage as lost while its work kept running unowned; the group id is the only
-- thing that lets the next boot find it and reap it. 0 means no group was
-- recorded (an agent stage, a stage that never launched, or a platform that
-- gives a command none).
--
-- Read with started_at, which is stamped by the same event: the pair is the
-- identity check that keeps a reused pid from being killed as if it were ours.
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs ADD COLUMN pgid INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pipeline_stage_runs DROP COLUMN pgid;
-- +goose StatementEnd
