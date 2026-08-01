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

-- name: SelectConversationTurns :many
SELECT * FROM conversation_turns
WHERE conversation_id = ?
ORDER BY requested_at, rowid;

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

-- name: SelectConversationMessages :many
SELECT * FROM conversation_messages
WHERE conversation_id = ?
ORDER BY sequence;

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

-- name: SelectConversationActivityByProviderItem :one
SELECT * FROM conversation_activities
WHERE conversation_id = ? AND provider_item_id = ?
LIMIT 1;

-- name: SelectConversationActivities :many
SELECT * FROM conversation_activities
WHERE conversation_id = ?
ORDER BY sequence;

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
