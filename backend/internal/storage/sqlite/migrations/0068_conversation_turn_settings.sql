-- +goose Up
-- +goose StatementBegin
-- Per-conversation provider choices: model, reasoning effort, approval posture.
--
-- These live on the conversation rather than in the renderer because the choice
-- has to survive a restart and has to apply to turns AO dispatches itself — the
-- send queue draining after a crash, `ao send` relaying from an orchestrator.
-- A value held only in the client would silently stop applying the moment the
-- user was not the one sending.
--
-- They are NULL until the user picks something. Empty is not the same as unset:
-- unset means "whatever the conversation was started with", which is how the
-- provider's own default keeps working and why adding these changes nothing for
-- a session that never touches them.
--
-- The provider takes all three per turn, so this is a preference for the NEXT
-- turn rather than a property of the running agent. Nothing here restarts a
-- controller.
ALTER TABLE conversations ADD COLUMN model TEXT;
ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT;
ALTER TABLE conversations ADD COLUMN approval_mode TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- SQLite cannot drop a column in the versions AO supports, and a rebuild would
-- have to re-declare the table plus its two partial indexes. The columns are
-- nullable and unread by older code, so leaving them is safe on a downgrade.
SELECT 1;
-- +goose StatementEnd
