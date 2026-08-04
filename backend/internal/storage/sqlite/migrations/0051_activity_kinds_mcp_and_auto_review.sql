-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
-- Widen conversation_activities.kind for two timeline entries AO could not
-- previously write.
--
--   mcp_tool     an MCP tool call. It was being recorded as 'command', which made
--                every tool call render as though the agent had run something in
--                the worktree. It has a server, a tool name, structured arguments
--                and a structured result; none of that is a shell invocation.
--
--   auto_review  an automatic approval review: the provider deciding, on the
--                user's behalf, whether an action was safe to run unattended.
--                Recording it as 'approval' would put it next to the cards that
--                are waiting for a person, and those are opposites -- one is a
--                question, the other is a decision already made.
--
-- A table rebuild because SQLite cannot alter a CHECK constraint in place. This
-- follows 0028, which widened projects.kind the same way, including the
-- foreign_keys pragma dance and the foreign_key_check that proves the copy did not
-- orphan anything.
--
-- The column list is 0043 plus 0047's command output columns plus 0050's streamed
-- text columns. Dropping the table also drops its indexes and its CDC trigger, so
-- all five are recreated verbatim below; a missing trigger would silently stop
-- chat activity from invalidating the session on every client.
PRAGMA foreign_keys=OFF;

CREATE TABLE conversation_activities_new (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id           TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    sequence          INTEGER NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    kind              TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'plan', 'reasoning', 'approval', 'usage', 'error', 'system', 'mcp_tool', 'auto_review')),
    -- 'running' can be terminal in practice: a provider may start a command and
    -- supersede it without ever completing it, so readers must tolerate that.
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'pending', 'resolved')),
    summary           TEXT NOT NULL DEFAULT '',
    detail_json       TEXT NOT NULL DEFAULT '',
    -- request_id is the provider's identifier for an approval. Resolving matches
    -- on it so a stale card cannot answer a newer request.
    request_id        TEXT NOT NULL DEFAULT '',
    provider_item_id  TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMP NOT NULL,
    updated_at        TIMESTAMP NOT NULL,
    command_output    TEXT NOT NULL DEFAULT '',
    command_output_truncated INTEGER NOT NULL DEFAULT 0,
    streamed_text     TEXT NOT NULL DEFAULT '',
    streamed_text_truncated  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (conversation_id, sequence)
);

INSERT INTO conversation_activities_new (
    id, conversation_id, turn_id, sequence, revision, kind, status, summary,
    detail_json, request_id, provider_item_id, created_at, updated_at,
    command_output, command_output_truncated, streamed_text, streamed_text_truncated
)
SELECT id, conversation_id, turn_id, sequence, revision, kind, status, summary,
       detail_json, request_id, provider_item_id, created_at, updated_at,
       command_output, command_output_truncated, streamed_text, streamed_text_truncated
FROM conversation_activities;

DROP TABLE conversation_activities;
ALTER TABLE conversation_activities_new RENAME TO conversation_activities;

CREATE UNIQUE INDEX idx_conversation_activities_provider_item
    ON conversation_activities(conversation_id, provider_item_id)
    WHERE provider_item_id <> '';
CREATE UNIQUE INDEX idx_conversation_activities_request
    ON conversation_activities(conversation_id, request_id)
    WHERE request_id <> '';
CREATE INDEX idx_conversation_activities_order
    ON conversation_activities(conversation_id, sequence);
-- "Is anything waiting on the user in this conversation?" on every render.
CREATE INDEX idx_conversation_activities_pending
    ON conversation_activities(conversation_id, kind, status);

CREATE TRIGGER conversation_activities_cdc_insert
AFTER INSERT ON conversation_activities
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
		   json_object('id', s.id, 'sessionId', s.id, 'conversationId', c.id,
					   'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM conversations c
    JOIN sessions s ON s.id = c.current_session_id
    WHERE c.id = NEW.conversation_id;
END;

CREATE TRIGGER conversation_activities_cdc_update
AFTER UPDATE ON conversation_activities
WHEN OLD.revision <> NEW.revision
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
		   json_object('id', s.id, 'sessionId', s.id, 'conversationId', c.id,
					   'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM conversations c
    JOIN sessions s ON s.id = c.current_session_id
    WHERE c.id = NEW.conversation_id;
END;

PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Narrowing the CHECK again would reject rows this build has already written, so a
-- downgrade keeps the widened constraint. The same best-effort shape 0028 uses.
SELECT 1;
-- +goose StatementEnd
