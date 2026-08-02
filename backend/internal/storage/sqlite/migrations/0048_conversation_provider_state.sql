-- +goose Up
-- +goose StatementBegin
-- Provider state a conversation carries but no turn owns.
--
-- Four independent latest-wins facts, each stored as one JSON column rather than
-- as a set of scalar columns. The precedent is conversation_turns.diff_json from
-- 0045, and the reasoning is the same: every one of these is a whole-value
-- overwrite that is only ever read whole, never queried by field, joined, or
-- aggregated. Fifteen scalar columns would buy query shapes nothing asks for and
-- would have to be kept mutually consistent by hand on every write.
--
-- NULL means the provider has never said, which is deliberately distinct from
-- saying nothing is true. A client must be able to tell "this conversation has
-- not reported an account" from "this conversation has no account".
--
--   model_reroute_json  the provider answering with a model other than the one
--                       asked for. This is a correction to a claim AO has already
--                       made: the composer names the model it sends to, so an
--                       unrecorded substitution leaves every later reading of that
--                       turn attributing the answer to the wrong model.
--
--   account_json        the auth mode, the plan, and the moment the provider last
--                       asked for credentials AO does not hold. The last of those
--                       is why this exists: a long-lived chat session outlives its
--                       credentials, and a turn that fails for that reason is
--                       indistinguishable from any other failure unless the demand
--                       for re-authentication is written down.
--
--   thread_state_json   the provider's own lifecycle view: working, idle,
--                       archived, closed, and what it is blocked on. NOT AO's
--                       session status, which stays derived from durable facts at
--                       read time. This is one more such fact, not a second answer.
--
--   mcp_servers_json    each tool server's startup state. It answers a question
--                       the timeline cannot: a tool call that never happened
--                       because its server failed to start reads, from the
--                       timeline alone, as the agent choosing not to use it.
--
-- No CDC trigger on any of these, following 0045. change_log is an invalidation
-- signal, and thread status alone changes twice per turn; the chat surface's
-- existing poll picks these up within a second.
ALTER TABLE conversations ADD COLUMN model_reroute_json TEXT;
ALTER TABLE conversations ADD COLUMN account_json TEXT;
ALTER TABLE conversations ADD COLUMN thread_state_json TEXT;
ALTER TABLE conversations ADD COLUMN mcp_servers_json TEXT;
-- +goose StatementEnd

-- +goose StatementBegin
-- The agent's plan for one turn, as JSON.
--
-- Per-turn state and not a stack of timeline entries, for exactly the reason
-- diff_json is: the provider re-sends the WHOLE plan on every change (measured:
-- three updates in one turn, each carrying all three steps with their statuses),
-- so the latest payload is the complete answer and the earlier ones are the same
-- plan with fewer boxes ticked. A row per update would read as though the agent
-- had planned three separate times.
--
-- Structured steps rather than the text the plan tool was called with. The status
-- per step is the whole point -- it is where the agent is up to -- and flattening
-- it to prose would throw that away.
ALTER TABLE conversation_turns ADD COLUMN plan_json TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose StatementBegin
-- Provider prose streamed for one activity, accumulated from deltas.
--
-- What it holds depends on the activity's kind, because each kind has exactly one
-- such stream: reasoning summary text for a reasoning activity, the keystrokes the
-- agent sent to a PTY for a command, progress messages for an MCP tool call, patch
-- output for a file change.
--
-- Deliberately NOT merged into command_output, which 0045 added for the same shape
-- of write. Three differences make one column wrong for both:
--
--   * command_output is a program's own bytes -- raw, ANSI-laden, and admitted by
--     the provider to be incomplete. A reader has to be able to tell "the agent
--     thought this" or "the agent typed this" from "the program printed this".
--   * a PTY echoes what is typed. Appending the agent's keystrokes to the same
--     stream the echo arrives on would print every command twice.
--   * they settle differently. Command output is only ever appended to; streamed
--     reasoning is REPLACED by the settled summary when the item completes, the
--     same way conversation_messages.text is replaced on message completion.
--
-- Capped in one statement like command_output, and for the same reason: the cap,
-- the concatenation and the truncation flag have to commit together or a runaway
-- stream can interleave a delta between a length check and the write that acts on
-- it. The flag is stored rather than derived because once appending stops, length
-- alone cannot distinguish a stream that ended at the cap from one that was cut.
ALTER TABLE conversation_activities ADD COLUMN streamed_text TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_activities ADD COLUMN streamed_text_truncated INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE conversation_activities DROP COLUMN streamed_text_truncated;
ALTER TABLE conversation_activities DROP COLUMN streamed_text;
ALTER TABLE conversation_turns DROP COLUMN plan_json;
-- +goose StatementEnd

-- +goose StatementBegin
-- SQLite in the versions AO supports cannot drop a column from a table carrying
-- partial indexes without a full rebuild, and conversations has two. All four
-- columns are nullable and unread by older code, so leaving them is safe on a
-- downgrade.
SELECT 1;
-- +goose StatementEnd
