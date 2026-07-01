-- +goose Up
-- session_collision is the durable fact that two non-terminated worker sessions
-- in the same project are concurrently editing overlapping code, detected by the
-- convergence observer from each session's worktree diff BEFORE either opens a
-- PR. It is a derived-but-cached fact: the observer recomputes it every tick and
-- upserts/deletes rows so the table always reflects the current overlap set.
--
-- session_a/session_b hold the pair in a stable lexical order (a < b) so an
-- unordered pair maps to exactly one row; the primary key enforces that. Rows
-- cascade-delete with either session and with the project, so terminating or
-- deleting a session cannot leave a dangling collision.
--
-- No CDC trigger is attached: collisions surface to the UI through the derived
-- `colliding` flag on the session read and the dedicated collisions endpoint,
-- and to agents through the lifecycle nudge — none of which consume change_log.
-- +goose StatementBegin
CREATE TABLE session_collision (
    project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    session_a     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    session_b     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    severity      TEXT NOT NULL CHECK (severity IN ('soft', 'hot')),
    files         TEXT NOT NULL CHECK (json_valid(files)),
    signature     TEXT NOT NULL,
    first_seen_at TIMESTAMP NOT NULL,
    updated_at    TIMESTAMP NOT NULL,
    PRIMARY KEY (session_a, session_b),
    CHECK (session_a < session_b)
);

CREATE INDEX idx_session_collision_project ON session_collision (project_id);
CREATE INDEX idx_session_collision_b ON session_collision (session_b);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_session_collision_b;
DROP INDEX IF EXISTS idx_session_collision_project;
DROP TABLE IF EXISTS session_collision;
-- +goose StatementEnd
