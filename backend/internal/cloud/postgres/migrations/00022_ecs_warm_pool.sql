-- +goose Up
CREATE TABLE ao_ecs_warm_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generation TEXT NOT NULL,
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    task_arn TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'launching'
        CHECK (state IN ('launching', 'ready', 'claimed', 'failed', 'stopped')),
    claimed_session_id UUID UNIQUE REFERENCES ao_sessions(id) ON DELETE SET NULL,
    ready_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ao_ecs_warm_tasks_task_arn_key
    ON ao_ecs_warm_tasks(task_arn)
    WHERE task_arn <> '';

CREATE INDEX ao_ecs_warm_tasks_ready_idx
    ON ao_ecs_warm_tasks(generation, created_at)
    WHERE state = 'ready';

CREATE INDEX ao_ecs_warm_tasks_launching_idx
    ON ao_ecs_warm_tasks(generation, created_at)
    WHERE state = 'launching';

ALTER TABLE ao_ecs_warm_tasks ENABLE ROW LEVEL SECURITY;

-- +goose Down
DROP TABLE IF EXISTS ao_ecs_warm_tasks;
