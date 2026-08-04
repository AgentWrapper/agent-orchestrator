-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
-- A structured question is neither a tool approval nor ordinary prose. It can
-- carry a form schema or a consent-gated external URL and remains pending until
-- the user accepts, declines, or cancels it. Widen the activity kind constraint
-- so that distinction survives persistence and every client refresh.
--
-- SQLite cannot alter a CHECK constraint in place, so this follows migration
-- 0051's table rebuild. The full column/index/CDC shape is recreated verbatim;
-- losing the insert trigger here would silently stop chat invalidation events.
PRAGMA foreign_keys=OFF;

CREATE TABLE conversation_activities_new (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id           TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    sequence          INTEGER NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    kind              TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'plan', 'reasoning', 'approval', 'usage', 'error', 'system', 'mcp_tool', 'auto_review', 'user_input')),
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'pending', 'resolved')),
    summary           TEXT NOT NULL DEFAULT '',
    detail_json       TEXT NOT NULL DEFAULT '',
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
-- Existing user_input rows cannot fit the old CHECK, so downgrade keeps the
-- widened constraint, matching the additive-kind policy in migration 0051.
SELECT 1;
-- +goose StatementEnd
