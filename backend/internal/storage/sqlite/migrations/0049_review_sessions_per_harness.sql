-- Persist reviewer terminal/native session state per reviewer harness so
-- switching reviewers can kill the active pane without losing the previous
-- harness' restorable conversation.

-- +goose Up
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

-- +goose StatementBegin
INSERT INTO review_session (session_id, project_id, harness, reviewer_handle_id, agent_session_id, created_at, updated_at)
SELECT session_id, project_id, harness, reviewer_handle_id, agent_session_id, created_at, updated_at
FROM review
WHERE harness != '';
-- +goose StatementEnd

-- +goose Down
DROP TABLE review_session;
