-- +goose Up
-- workspace_mode preserves the per-session workspace mode ("worktree" /
-- "in-place") resolved at spawn so restore never re-reads it from project
-- config — a later config flip must not relocate an already-running session.
-- Existing rows read back as '' (the pre-upgrade shape), which the session
-- manager normalizes to worktree, so no session is rug-pulled by the upgrade.
ALTER TABLE sessions ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN workspace_mode;
