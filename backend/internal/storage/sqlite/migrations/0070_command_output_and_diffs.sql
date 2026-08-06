-- +goose Up
-- +goose StatementBegin
-- Streamed command output, accumulated per activity.
--
-- Why a dedicated column and not detail_json: an output delta arrives many times
-- per command, and folding each one into the JSON payload would mean parse,
-- mutate, re-encode, rewrite on every delta. That is quadratic in the number of
-- deltas AND it makes the typed payload a mutable buffer, so a malformed encode
-- mid-command would take the command's cwd and exit code down with it. A plain
-- TEXT column appends with `command_output = command_output || ?` -- the same
-- shape conversation_messages already uses for assistant text, which is the
-- identical problem.
--
-- Why not a separate chunk table: a row per delta is a cheaper append, but the
-- timeline snapshot is read on every poll (once a second while a turn runs), so
-- every read would pay a join and a re-concatenation to rebuild text that is only
-- ever consumed whole. It also multiplies row count by output volume, and the
-- size cap below would still be needed to bound it. Cheaper writes on the rare
-- path are not worth more expensive reads on the constant one.
ALTER TABLE conversation_activities ADD COLUMN command_output TEXT NOT NULL DEFAULT '';

-- Set when the accumulated output hit its cap and stopped growing. Stored rather
-- than derived: once appending stops, length alone cannot distinguish "a command
-- that printed exactly the cap" from "a command that printed more and was cut",
-- and a reader must be told which it is looking at instead of guessing.
ALTER TABLE conversation_activities ADD COLUMN command_output_truncated INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose StatementBegin
-- The turn's changed-file summary, as JSON.
--
-- Per-turn state, not a timeline entry: the provider re-sends the whole diff on
-- every update (observed three byte-identical payloads inside one turn), so a row
-- per notification would stack duplicates in the conversation and make the
-- timeline read as though the same edits happened repeatedly. Overwriting one
-- column per turn keeps the latest answer and nothing else.
--
-- JSON rather than a conversation_turn_files table: this is a whole-value
-- overwrite that is only ever read whole, never queried by path, joined, or
-- aggregated across turns. A child table would buy query shapes nothing asks for
-- and would need a delete-then-insert on each update to stay consistent with a
-- payload the provider already sends complete.
ALTER TABLE conversation_turns ADD COLUMN diff_json TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- Deliberately no CDC trigger on either column. change_log is an invalidation
-- signal, and 0041 already established that high-frequency streaming deltas stay
-- out of it. A trigger firing per output delta would put thousands of rows into
-- change_log for one noisy command, to tell every listener something the chat
-- surface's existing poll already picks up within a second.

-- +goose Down
-- +goose StatementBegin
ALTER TABLE conversation_turns DROP COLUMN diff_json;
ALTER TABLE conversation_activities DROP COLUMN command_output_truncated;
ALTER TABLE conversation_activities DROP COLUMN command_output;
-- +goose StatementEnd
