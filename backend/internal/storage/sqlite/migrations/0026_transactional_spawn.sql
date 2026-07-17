-- +goose Up
ALTER TABLE sessions ADD COLUMN generation TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN spawn_state TEXT NOT NULL DEFAULT ''
    CHECK (spawn_state IN ('', 'spawned'));

CREATE TABLE spawn_reservations (
    request_id  TEXT NOT NULL,
    generation  TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL UNIQUE,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    num         INTEGER NOT NULL,
    state       TEXT NOT NULL DEFAULT 'launching'
        CHECK (state IN ('launching', 'spawned')),
    created_at  TIMESTAMP NOT NULL,
    UNIQUE(project_id, num),
    UNIQUE(project_id, request_id)
);

-- +goose Down
DROP TABLE spawn_reservations;
ALTER TABLE sessions DROP COLUMN spawn_state;
ALTER TABLE sessions DROP COLUMN generation;
