-- Chat conversation storage.
--
-- Ordering has a single writer: NextConversationSequence bumps and returns
-- latest_sequence, and callers use that value for the row they are about to
-- insert. Both statements run inside one store-level transaction so two
-- concurrent writers cannot mint the same position.

-- name: InsertConversation :exec
INSERT INTO conversations (id, scope, project_id, session_id, latest_sequence, created_at, updated_at)
VALUES (?, ?, ?, ?, 0, ?, ?);

-- name: SelectConversationBySession :one
SELECT * FROM conversations WHERE session_id = ? LIMIT 1;

-- name: SelectConversationByID :one
SELECT * FROM conversations WHERE id = ? LIMIT 1;

-- The next turn's provider choices. Written only when the user picks something,
-- so NULL keeps meaning "use whatever the conversation was started with".
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: UpdateConversationTurnSettings :exec
UPDATE conversations
SET model = ?, reasoning_effort = ?, approval_mode = ?, updated_at = ?
WHERE id = ?;

-- Token position for the conversation, latest wins.
--
-- The provider reports this after every tool call, so this UPDATE runs often and
-- deliberately overwrites: there is one current answer to "how full is this
-- conversation", and keeping the history of that answer is what buried the
-- timeline before. updated_at is deliberately NOT touched -- usage arriving is the
-- provider talking about the conversation, not the conversation changing, and
-- bumping it on every tool call would make every chat session look freshly active.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: UpdateConversationUsage :exec
UPDATE conversations
SET context_used = ?,
    context_window = ?,
    usage_input_tokens = ?,
    usage_output_tokens = ?,
    usage_cached_tokens = ?,
    usage_total_tokens = ?
WHERE id = ?;

-- Account quota position, latest wins. Percentages in 0..100; the resets columns
-- are remaining seconds, not the absolute instant the provider sends.
-- name: UpdateConversationRateLimits :exec
UPDATE conversations
SET rate_limit_primary_percent = ?,
    rate_limit_secondary_percent = ?,
    rate_limit_primary_resets_in = ?,
    rate_limit_secondary_resets_in = ?,
    rate_limit_plan = ?
WHERE id = ?;

-- When the conversation's history was last summarized to reclaim context. Set
-- alongside the timeline row so the two cannot disagree about whether a
-- compaction happened.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: MarkConversationCompacted :exec
UPDATE conversations
SET compacted_at = ?, updated_at = ?
WHERE id = ?;

-- The thread title the provider reports for this conversation. Kept even when the
-- user has overridden the AO label, because it is the name the conversation has in
-- the provider's own history.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: UpdateConversationProviderTitle :exec
UPDATE conversations
SET provider_title = ?, updated_at = ?
WHERE id = ?;

-- The last title AO pushed into sessions.display_name. It is the compare-and-set
-- witness that lets a later provider title replace a label AO wrote while never
-- replacing one a person chose.
-- name: UpdateConversationAppliedTitle :exec
UPDATE conversations
SET applied_title = ?, updated_at = ?
WHERE id = ?;

-- name: NextConversationSequence :one
UPDATE conversations
SET latest_sequence = latest_sequence + 1, updated_at = ?
WHERE id = ?
RETURNING latest_sequence;

-- name: InsertConversationTurn :exec
INSERT INTO conversation_turns (
    id, conversation_id, handled_by_session_id, provider_turn_id,
    controller_generation, state, requested_at
) VALUES (?, ?, ?, ?, ?, ?, ?);

-- Correlating a provider notification back to its turn happens on every streamed
-- event, so it is a keyed lookup rather than a scan.
-- name: SelectConversationTurnByProviderID :one
SELECT * FROM conversation_turns
WHERE conversation_id = ? AND provider_turn_id = ?
LIMIT 1;

-- name: BindConversationTurnProviderID :exec
UPDATE conversation_turns
SET provider_turn_id = ?, started_at = COALESCE(started_at, ?)
WHERE id = ?;

-- name: MarkConversationTurnStarted :exec
UPDATE conversation_turns
SET state = 'running', started_at = COALESCE(started_at, ?)
WHERE id = ?;

-- name: SettleConversationTurn :exec
UPDATE conversation_turns
SET state = ?, error_message = ?, completed_at = ?
WHERE id = ?;

-- Restart reconciliation: a turn left running by a dead controller is not
-- evidence the work finished, so it is settled honestly rather than silently
-- completed.
-- name: SettleOrphanedConversationTurns :exec
UPDATE conversation_turns
SET state = 'failed',
    error_message = 'controller ended before the turn completed',
    completed_at = ?
WHERE handled_by_session_id = ? AND state IN ('queued', 'running');

-- Overwrite the turn's changed-file summary. The provider re-sends the whole diff
-- on every update, so the latest payload is the complete answer and there is
-- nothing to merge with what was there before.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: UpdateConversationTurnDiff :execrows
UPDATE conversation_turns
SET diff_json = ?
WHERE conversation_id = ? AND provider_turn_id = ?;

-- name: SelectConversationTurnByID :one
SELECT * FROM conversation_turns WHERE id = ? LIMIT 1;

-- Turns are read in full, rolled-back ones included. They carry rolled_back_at, so
-- a client can report how much an undo discarded instead of watching the timeline
-- silently shrink.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: SelectConversationTurns :many
SELECT * FROM conversation_turns
WHERE conversation_id = ?
ORDER BY requested_at, rowid;

-- Everything from the named turn to the end of the conversation, which is the range
-- an undo discards. Inclusive of the named turn: the state a person wants back is
-- the one from before they sent the message they pointed at.
--
-- The cut is on rowid rather than requested_at because rowid is assigned by the
-- insert and strictly increasing, so it orders turns recorded in the same clock tick
-- the same way SelectConversationTurns does. Two turns sharing a timestamp is
-- ordinary; two turns sharing a rowid is impossible.
-- name: MarkConversationTurnsRolledBack :execrows
UPDATE conversation_turns
SET rolled_back_at = ?
WHERE conversation_turns.conversation_id = ?
  AND conversation_turns.rolled_back_at IS NULL
  AND conversation_turns.rowid >= (
      SELECT anchor.rowid FROM conversation_turns AS anchor WHERE anchor.id = ?
  );

-- A discarded turn that never reached the provider settles as interrupted rather
-- than staying queued forever. Nothing went wrong and nothing failed: the user
-- undid the conversation out from under a message that was still waiting, and
-- dispatching it later would send it against a history it was never written for.
-- name: InterruptRolledBackQueuedTurns :exec
UPDATE conversation_turns
SET state = 'interrupted', completed_at = ?
WHERE conversation_id = ?
  AND state IN ('queued', 'running')
  AND rolled_back_at IS NOT NULL;

-- An approval inside a discarded turn can never be answered: the provider call it
-- was blocking belongs to history the provider has dropped. A rollback is refused
-- while a turn runs, so in practice there is nothing here to close; the statement
-- exists so the invariant is enforced rather than argued.
-- name: FailRolledBackConversationApprovals :exec
UPDATE conversation_activities
SET status = 'failed', revision = revision + 1, updated_at = ?
WHERE conversation_activities.conversation_id = ?
  AND conversation_activities.kind = 'approval'
  AND conversation_activities.status = 'pending'
  AND conversation_activities.turn_id IN (
      SELECT discarded.id FROM conversation_turns AS discarded
      WHERE discarded.conversation_id = ? AND discarded.rolled_back_at IS NOT NULL
  );

-- The head of the send queue: the oldest message recorded while the agent was
-- busy. Joined to its own user message because dispatching needs the text, and
-- the queue is durable rows rather than controller memory, so a restart can see
-- what was never sent.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: SelectNextQueuedConversationTurn :one
SELECT conversation_turns.id,
       conversation_messages.text,
       conversation_messages.client_message_id,
       conversation_messages.origin
FROM conversation_turns
JOIN conversation_messages
    ON conversation_messages.turn_id = conversation_turns.id
    AND conversation_messages.role = 'user'
WHERE conversation_turns.conversation_id = ? AND conversation_turns.state = 'queued'
ORDER BY conversation_turns.requested_at, conversation_turns.rowid
LIMIT 1;

-- Stopping the agent stops the queue with it: a brake that starts new work
-- instead of ending it would be the wrong shape for the button the user pressed.
-- The cutoff is the moment the user pressed stop, so a message typed after that
-- is still delivered rather than swept up by a cancellation it predates.
-- name: CancelQueuedConversationTurns :exec
UPDATE conversation_turns
SET state = 'interrupted', completed_at = ?
WHERE conversation_id = ? AND state = 'queued' AND requested_at <= ?;

-- name: InsertConversationMessage :exec
INSERT INTO conversation_messages (
    id, conversation_id, turn_id, sequence, revision, role, origin,
    text, streaming, provider_item_id, client_message_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- Folding a streaming delta: append to the existing text and bump the revision
-- so a client can detect a gap. The provider item id is the correlation key
-- because AO does not know the message id the provider will use.
-- name: AppendConversationMessageDelta :exec
UPDATE conversation_messages
SET text = text || ?, revision = revision + 1, streaming = 1, updated_at = ?
WHERE conversation_id = ? AND provider_item_id = ?;

-- name: SettleConversationMessage :exec
UPDATE conversation_messages
SET text = ?, revision = revision + 1, streaming = 0, updated_at = ?
WHERE conversation_id = ? AND provider_item_id = ?;

-- name: SelectConversationMessageByProviderItem :one
SELECT * FROM conversation_messages
WHERE conversation_id = ? AND provider_item_id = ?
LIMIT 1;

-- name: SelectConversationMessageByClientID :one
SELECT * FROM conversation_messages
WHERE conversation_id = ? AND client_message_id = ?
LIMIT 1;

-- Prose the agent still remembers. Rows belonging to a rolled-back turn are left
-- out: rollback discarded them provider-side, and showing a person a message the
-- agent has no memory of is the one way this feature can lie.
--
-- Rows with turn_id IS NULL survive the filter on purpose. Those are items the
-- provider never attributed to a turn, and hiding what AO cannot prove belonged to
-- the discarded range would be a guess dressed up as a fact.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: SelectConversationMessages :many
SELECT * FROM conversation_messages
WHERE conversation_messages.conversation_id = ?
  AND (conversation_messages.turn_id IS NULL OR conversation_messages.turn_id NOT IN (
      SELECT discarded.id FROM conversation_turns AS discarded
      WHERE discarded.conversation_id = ? AND discarded.rolled_back_at IS NOT NULL
  ))
ORDER BY conversation_messages.sequence;

-- name: InsertConversationActivity :exec
INSERT INTO conversation_activities (
    id, conversation_id, turn_id, sequence, revision, kind, status,
    summary, detail_json, request_id, provider_item_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: SettleConversationActivity :exec
UPDATE conversation_activities
SET status = ?, summary = ?, detail_json = ?, revision = revision + 1, updated_at = ?
WHERE conversation_id = ? AND provider_item_id = ?;

-- Resolving an approval matches on the provider's request id, so a card the user
-- left on screen cannot answer a request that replaced it.
-- name: ResolveConversationApproval :exec
UPDATE conversation_activities
SET status = 'resolved', detail_json = ?, revision = revision + 1, updated_at = ?
WHERE conversation_id = ? AND request_id = ? AND status = 'pending';

-- Any approval still pending when a controller dies can never be answered: the
-- provider call it was blocking is gone.
-- name: FailPendingConversationApprovals :exec
UPDATE conversation_activities
SET status = 'failed', revision = revision + 1, updated_at = ?
WHERE conversation_id = ? AND kind = 'approval' AND status = 'pending';

-- Append streamed command output, capped in one statement.
--
-- The cap is applied here rather than in Go so the read, the concatenation, and
-- the truncation flag commit atomically: a runaway command must not be able to
-- interleave a second delta between a length check and the write that acts on it.
-- substr() does the capping and the CASE records that it happened, so output is
-- never silently cut.
--
-- SQLite length() on TEXT counts characters, not bytes, so the byte ceiling is up
-- to 4x max_output_chars in pathological UTF-8. That is still bounded and far
-- below the megabytes-per-row this exists to prevent; command output is
-- overwhelmingly ASCII.
--
-- execrows so the caller can tell "appended" from "no such activity yet", which
-- is a real case: a delta can arrive before the item/started that creates the row.
-- NOTE: keep these comments ASCII. sqlc locates its star-expansion edits by byte
-- offset, so a multi-byte character here silently corrupts later queries.
-- name: AppendConversationActivityOutput :execrows
UPDATE conversation_activities
SET command_output = substr(command_output || sqlc.arg(delta), 1, sqlc.arg(max_output_chars)),
    command_output_truncated = CASE
        WHEN length(command_output) + length(sqlc.arg(delta)) > sqlc.arg(max_output_chars) THEN 1
        ELSE command_output_truncated
    END,
    revision = revision + 1,
    updated_at = sqlc.arg(updated_at)
WHERE conversation_id = sqlc.arg(conversation_id)
  AND provider_item_id = sqlc.arg(provider_item_id);

-- name: SelectConversationActivityByProviderItem :one
SELECT * FROM conversation_activities
WHERE conversation_id = ? AND provider_item_id = ?
LIMIT 1;

-- Activities the agent still remembers, filtered the same way messages are and for
-- the same reason. See SelectConversationMessages.
-- name: SelectConversationActivities :many
SELECT * FROM conversation_activities
WHERE conversation_activities.conversation_id = ?
  AND (conversation_activities.turn_id IS NULL OR conversation_activities.turn_id NOT IN (
      SELECT discarded.id FROM conversation_turns AS discarded
      WHERE discarded.conversation_id = ? AND discarded.rolled_back_at IS NOT NULL
  ))
ORDER BY conversation_activities.sequence;

-- Push a provider thread title into the session label, without ever overwriting a
-- name a person chose.
--
-- One statement, not a read followed by a write: a manual rename landing between the
-- two would be silently discarded. The guard admits exactly two cases - the session
-- has no label yet, or it still carries the title AO last wrote - so anything a user
-- typed wins by simply not matching.
--
-- It lives with the conversation queries rather than the session ones because it is
-- part of the conversation title lifecycle; sessions is only the table the value
-- lands in.
-- name: ApplyConversationTitleToSession :execrows
UPDATE sessions
SET display_name = ?, updated_at = ?
WHERE id = ?
  AND (display_name = '' OR display_name = ?);

-- The raw provider event archive. Append-only, and the only way to answer "what
-- did the provider actually say" once a projection turns out to be wrong.
-- name: InsertConversationProviderEvent :exec
INSERT INTO conversation_provider_events (
    conversation_id, session_id, provider_event_id, method, payload_json, received_at
) VALUES (?, ?, ?, ?, ?, ?);

-- name: SelectConversationProviderEvents :many
SELECT * FROM conversation_provider_events
WHERE conversation_id = ? AND id > ?
ORDER BY id
LIMIT ?;
