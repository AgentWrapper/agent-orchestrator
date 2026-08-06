-- +goose Up
-- +goose StatementBegin
-- Token position and account quota, as current state on the conversation.
--
-- These are latest-wins columns rather than a table of updates, and that is the
-- whole design decision. The provider reports token usage after every tool call,
-- so a session with thirty tool calls produces thirty reports. Storing one row per
-- report is what buried the actual conversation in the timeline the first time
-- this signal was handled; there is only ever one current answer to "how full is
-- this conversation" and "how close is this account to a wall", so only the
-- current answer is kept.
--
-- context_used and context_window are stored together and are the point of the
-- exercise: a used figure without the window is a number with no scale, which is
-- what the header showed before. The window is nullable because the provider
-- omits it for models it will not state one for, and a meter with no scale must
-- render as "unknown" rather than as "empty".
--
-- The cumulative input/output/cached/total columns are the conversation's spend.
-- They are kept apart from the context figures because they answer a different
-- question: spend grows without bound across a conversation, while context
-- fullness rises and falls as history is compacted.
--
-- Rate limits are percentages in 0..100, not token counts, and the reset columns
-- are remaining seconds rather than the absolute instant the provider sends. A
-- duration is what survives being read back later: an absolute timestamp from a
-- provider whose clock AO cannot verify would render as already-refilled the
-- moment it went stale. NULL throughout means the provider never reported, which
-- is deliberately distinct from reporting zero.
ALTER TABLE conversations ADD COLUMN context_used INTEGER;
ALTER TABLE conversations ADD COLUMN context_window INTEGER;
ALTER TABLE conversations ADD COLUMN usage_input_tokens INTEGER;
ALTER TABLE conversations ADD COLUMN usage_output_tokens INTEGER;
ALTER TABLE conversations ADD COLUMN usage_cached_tokens INTEGER;
ALTER TABLE conversations ADD COLUMN usage_total_tokens INTEGER;
ALTER TABLE conversations ADD COLUMN rate_limit_primary_percent REAL;
ALTER TABLE conversations ADD COLUMN rate_limit_secondary_percent REAL;
ALTER TABLE conversations ADD COLUMN rate_limit_primary_resets_in INTEGER;
ALTER TABLE conversations ADD COLUMN rate_limit_secondary_resets_in INTEGER;
ALTER TABLE conversations ADD COLUMN rate_limit_plan TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- SQLite cannot drop a column in the versions AO supports, and a rebuild would
-- have to re-declare the table plus its two partial indexes. The columns are
-- nullable and unread by older code, so leaving them is safe on a downgrade.
SELECT 1;
-- +goose StatementEnd
