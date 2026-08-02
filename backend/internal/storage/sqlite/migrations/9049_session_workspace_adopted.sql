-- +goose Up
-- workspace_adopted marks a session that runs in a tree it does not own: the
-- spawn named an existing workspace (a pipeline run's, spec section 5) instead
-- of creating a worktree. Every teardown path reads it before removing a
-- worktree, so it has to survive a daemon restart the same way workspace_path
-- does: an adopted session read back with the flag lost would hand a live run's
-- workspace to session cleanup.
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN workspace_adopted BOOLEAN NOT NULL DEFAULT FALSE;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN workspace_adopted;
-- +goose StatementEnd
