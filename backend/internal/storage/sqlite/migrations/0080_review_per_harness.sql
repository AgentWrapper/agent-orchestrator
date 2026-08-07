-- Store reviewer lifecycle state directly in one review row per worker and
-- harness. This uses a fresh version above the current migration tip because
-- field databases can have 0049 recorded as applied already.

-- +goose NO TRANSACTION

-- +goose Up
-- +goose StatementBegin
PRAGMA foreign_keys=OFF;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE review_next (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    project_id         TEXT NOT NULL REFERENCES projects (id),
    harness            TEXT NOT NULL,
    pr_url             TEXT NOT NULL DEFAULT '',
    reviewer_handle_id TEXT NOT NULL DEFAULT '',
    agent_session_id   TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMP NOT NULL,
    updated_at         TIMESTAMP NOT NULL,
    UNIQUE(session_id, harness)
);
-- +goose StatementEnd

-- Preserve the canonical review row and its id because review_run.review_id
-- references it. It wins when 0048's review_session table contains the same
-- worker/harness pair.
-- +goose StatementBegin
INSERT INTO review_next (
    id, session_id, project_id, harness, pr_url, reviewer_handle_id,
    agent_session_id, created_at, updated_at
)
SELECT
    id, session_id, project_id, harness, pr_url, reviewer_handle_id,
    agent_session_id, created_at, updated_at
FROM review;
-- +goose StatementEnd

-- Preserve additional harness-specific lifecycle rows created under 0048.
-- They had no review id of their own, so assign one while retaining their
-- terminal/native-session state.
-- +goose StatementBegin
INSERT OR IGNORE INTO review_next (
    id, session_id, project_id, harness, pr_url, reviewer_handle_id,
    agent_session_id, created_at, updated_at
)
SELECT
    'review-session-' || lower(hex(randomblob(16))),
    rs.session_id,
    rs.project_id,
    rs.harness,
    COALESCE((SELECT r.pr_url FROM review r WHERE r.session_id = rs.session_id), ''),
    rs.reviewer_handle_id,
    rs.agent_session_id,
    rs.created_at,
    rs.updated_at
FROM review_session rs;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE review_session;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE review;
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE review_next RENAME TO review;
-- +goose StatementEnd

-- +goose StatementBegin
PRAGMA foreign_keys=ON;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
PRAGMA foreign_keys=OFF;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE review_prev (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL UNIQUE REFERENCES sessions (id) ON DELETE CASCADE,
    project_id         TEXT NOT NULL REFERENCES projects (id),
    harness            TEXT NOT NULL,
    pr_url             TEXT NOT NULL DEFAULT '',
    reviewer_handle_id TEXT NOT NULL DEFAULT '',
    agent_session_id   TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMP NOT NULL,
    updated_at         TIMESTAMP NOT NULL
);
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
INSERT INTO review_session (
    session_id, project_id, harness, reviewer_handle_id,
    agent_session_id, created_at, updated_at
)
SELECT
    session_id, project_id, harness, reviewer_handle_id,
    agent_session_id, created_at, updated_at
FROM review;
-- +goose StatementEnd

-- The legacy review table can retain only one harness per worker. Prefer a
-- live terminal, then the most recently updated row.
-- +goose StatementBegin
INSERT INTO review_prev (
    id, session_id, project_id, harness, pr_url, reviewer_handle_id,
    agent_session_id, created_at, updated_at
)
SELECT
    id, session_id, project_id, harness, pr_url, reviewer_handle_id,
    agent_session_id, created_at, updated_at
FROM (
    SELECT review.*,
           ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY CASE WHEN reviewer_handle_id != '' THEN 0 ELSE 1 END,
                        updated_at DESC,
                        created_at DESC,
                        id DESC
           ) AS rn
    FROM review
)
WHERE rn = 1;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE review;
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE review_prev RENAME TO review;
-- +goose StatementEnd

-- +goose StatementBegin
PRAGMA foreign_keys=ON;
-- +goose StatementEnd
