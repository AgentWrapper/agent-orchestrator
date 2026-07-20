-- +goose Up
-- +goose StatementBegin
-- shell_terminals are standalone shell panes: a PTY the user opens by hand
-- (the "+ Terminal" action), NOT bound to any agent session. They deliberately
-- carry no FK to sessions and emit no CDC, so they never surface on the board.
--
-- Only the facts needed to re-attach after a daemon restart are persisted. The
-- PTY itself lives in the runtime (a tmux session / conpty pty-host) which
-- outlives the daemon process, so the daemon can find its shells again by
-- handle_id alone.
--
-- app_run_id is what makes "survive a daemon restart, die with the app" work.
-- It is minted once per desktop-app launch, so rows written by the CURRENT app
-- run are re-attachable, while rows left behind by a PREVIOUS run (the app
-- crashed or was force-killed before it could close them cleanly) are
-- identifiable as orphans and destroyed on the next boot.
--
-- project_id is nullable on purpose: a shell can be opened with no project
-- context, in which case it starts in the daemon's data dir.
CREATE TABLE shell_terminals (
    handle_id   TEXT PRIMARY KEY,
    project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
    working_dir TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    app_run_id  TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL
);

-- The two hot reads: list the current run's shells (to repopulate tabs after a
-- daemon restart) and find previous runs' orphans (to reap them at boot).
CREATE INDEX idx_shell_terminals_app_run
    ON shell_terminals(app_run_id, created_at);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_shell_terminals_app_run;
DROP TABLE IF EXISTS shell_terminals;
-- +goose StatementEnd
