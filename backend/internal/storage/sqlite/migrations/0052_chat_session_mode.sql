-- +goose Up
-- +goose StatementBegin
-- Chat/TUI session modes and the durable conversation model behind Chat.
--
-- session_mode is decided before the initial controller launches. A durable,
-- compare-and-swap interface transition may change it later, but a live session
-- still has exactly one controller: two writers on one provider conversation race
-- on turns, approvals, compaction, and reconnect state. Every send/restore/kill/
-- reaper decision dispatches from this column, never from the current default.
--
-- The DEFAULT plus NOT NULL is what backfills every pre-existing session to
-- 'tui', so an upgrade changes no existing workflow.
ALTER TABLE sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'tui';

-- provider_conversation_id is the opaque handle the Chat driver needs to resume
-- after a daemon or provider restart (a Codex thread id today). Empty for TUI
-- sessions. Deliberately separate from agent_session_id, which describes the
-- native-TUI resume path and means something different.
ALTER TABLE sessions ADD COLUMN provider_conversation_id TEXT NOT NULL DEFAULT '';

-- controller_generation is bumped every time a Chat controller is (re)started for
-- a session. Events carrying an older generation are rejected, so a dying
-- controller cannot mutate the session that replaced it. Not the same thing as
-- runtime_launch_id, which fences terminal runtimes.
ALTER TABLE sessions ADD COLUMN controller_generation TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose StatementBegin
-- A conversation is one narrative. Session-scoped for workers; project-scoped for
-- the orchestrator, whose human-facing history must outlive any single
-- orchestrator session. The slice only creates session-scoped rows, but the
-- column exists from the start so widening the scope later is a value change
-- rather than a schema migration.
--
-- latest_sequence is the single writer for ordering. Messages and activities take
-- latest_sequence+1 inside the same transaction that bumps it, so two concurrent
-- writers cannot mint the same position.
CREATE TABLE conversations (
    id              TEXT PRIMARY KEY,
    scope           TEXT NOT NULL CHECK (scope IN ('session', 'project')),
	project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	-- The controller currently responsible for the narrative. For workers this
	-- equals session_id. For project-scoped orchestrators it is rebound whenever
	-- AO creates a clean replacement, while session_id remains NULL by scope.
	current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    latest_sequence INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP NOT NULL,
    -- One conversation per session, and one per project for the orchestrator.
    CHECK ((scope = 'session' AND session_id IS NOT NULL)
        OR (scope = 'project' AND session_id IS NULL))
);

CREATE UNIQUE INDEX idx_conversations_session ON conversations(session_id)
    WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversations_project_scope ON conversations(project_id)
	WHERE scope = 'project';
CREATE INDEX idx_conversations_current_session ON conversations(current_session_id)
	WHERE current_session_id IS NOT NULL;
-- +goose StatementEnd

-- +goose StatementBegin
-- One user or automation request plus the agent work it caused.
--
-- handled_by_session_id is which AO session's controller ran the turn. For a
-- project-scoped conversation this changes when the orchestrator is replaced,
-- while the conversation identity does not.
CREATE TABLE conversation_turns (
    id                     TEXT PRIMARY KEY,
    conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    handled_by_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider_turn_id       TEXT NOT NULL DEFAULT '',
    controller_generation  TEXT NOT NULL DEFAULT '',
    -- 'interrupted' is distinct from 'failed': the provider reports a cancelled
    -- turn with its own terminal status and AO must not relabel it as an error.
    state                  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
    error_message          TEXT NOT NULL DEFAULT '',
    requested_at           TIMESTAMP NOT NULL,
    started_at             TIMESTAMP,
    completed_at           TIMESTAMP
);

CREATE INDEX idx_conversation_turns_conversation ON conversation_turns(conversation_id, requested_at);
-- Correlating a provider notification back to a turn is the hot path on every
-- streamed event.
CREATE UNIQUE INDEX idx_conversation_turns_provider ON conversation_turns(conversation_id, provider_turn_id)
    WHERE provider_turn_id <> '';
-- +goose StatementEnd

-- +goose StatementBegin
-- Readable text. Separate from activities because assistant text is rewritten in
-- place as deltas arrive, while an activity is written once with a typed payload.
--
-- revision increases on each streaming rewrite so a client can detect a gap and
-- resync rather than render stale text. sequence is immutable; timestamps are
-- display metadata and never the ordering key.
CREATE TABLE conversation_messages (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id           TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    sequence          INTEGER NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    -- origin is structural. Worker/automation identity is never inferred from a
    -- text prefix.
    origin            TEXT NOT NULL CHECK (origin IN ('human', 'automation', 'daemon', 'provider')),
    text              TEXT NOT NULL DEFAULT '',
    streaming          INTEGER NOT NULL DEFAULT 0,
    provider_item_id  TEXT NOT NULL DEFAULT '',
    client_message_id TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMP NOT NULL,
    updated_at        TIMESTAMP NOT NULL,
    UNIQUE (conversation_id, sequence)
);

-- Folding a delta into its message is the highest-frequency lookup in Chat.
CREATE UNIQUE INDEX idx_conversation_messages_provider_item
    ON conversation_messages(conversation_id, provider_item_id)
    WHERE provider_item_id <> '';
-- A retried send carrying the same client id must find the existing row instead
-- of creating a second provider turn.
CREATE UNIQUE INDEX idx_conversation_messages_client_id
    ON conversation_messages(conversation_id, client_message_id)
    WHERE client_message_id <> '';
CREATE INDEX idx_conversation_messages_order
    ON conversation_messages(conversation_id, sequence);
-- +goose StatementEnd

-- +goose StatementBegin
-- Everything in the timeline that is not prose: commands, diffs, plans,
-- reasoning, approvals, usage, errors. Provider-specific detail lives in the JSON
-- payload rather than in a new kind per provider event subtype.
CREATE TABLE conversation_activities (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id           TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    sequence          INTEGER NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    kind              TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'plan', 'reasoning', 'approval', 'usage', 'error', 'system')),
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
    UNIQUE (conversation_id, sequence)
);

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
-- +goose StatementEnd

-- +goose StatementBegin
-- Raw provider events, append-only.
--
-- Two jobs. First, deduplication: a provider can report the same event twice
-- across a reconnect, and provider_event_id makes that cheap to detect. Second,
-- and the reason it keeps the payload: it is the only way to answer "what did the
-- provider actually say" after AO's own projection turns out to be wrong. Without
-- it, a projection bug is unrecoverable — the evidence is gone. It is not a
-- second transcript and is never model context.
CREATE TABLE conversation_provider_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider_event_id  TEXT NOT NULL DEFAULT '',
    method             TEXT NOT NULL,
    payload_json       TEXT NOT NULL,
    received_at        TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX idx_conversation_provider_events_dedupe
    ON conversation_provider_events(conversation_id, provider_event_id)
    WHERE provider_event_id <> '';
CREATE INDEX idx_conversation_provider_events_replay
    ON conversation_provider_events(conversation_id, id);
-- +goose StatementEnd

-- +goose StatementBegin
-- CDC. Change events come from triggers, following the existing rule, and the
-- payload is a compact invalidation signal — never chat prose. These fire on new
-- timeline rows, streamed row revisions, and turn-state transitions; the client
-- debounces them and refetches only the bounded live page.
--
-- They emit 'session_updated' rather than a new event type on purpose.
-- change_log.event_type carries a CHECK allowlist, and SQLite cannot alter a
-- CHECK in place: adding a type means rebuilding the table and re-declaring
-- every existing trigger (see 0006), which is a lot of risk to buy a label. The
-- payload shape is kept byte-identical to the existing session triggers so no
-- CDC consumer needs to change, and a client that refetches the session on this
-- signal refetches its conversation alongside. Introducing a dedicated
-- 'conversation_updated' type later is a mechanical follow-up if the distinction
-- earns its keep.
CREATE TRIGGER conversation_messages_cdc_insert
AFTER INSERT ON conversation_messages
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
		   json_object('id', s.id, 'sessionId', s.id, 'conversationId', NEW.conversation_id,
					   'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM conversations c
	JOIN sessions s ON s.id = c.current_session_id
    WHERE c.id = NEW.conversation_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
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
-- +goose StatementEnd

-- +goose StatementBegin
-- Streaming rewrites an existing row. Emit the same semantic invalidation as an
-- insert so clients fetch the bounded live page only when something changed,
-- rather than polling the entire conversation on a timer.
CREATE TRIGGER conversation_messages_cdc_update
AFTER UPDATE ON conversation_messages
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
-- +goose StatementEnd

-- +goose StatementBegin
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
-- +goose StatementEnd

-- +goose StatementBegin
-- A turn reaching a terminal state changes the session's derived activity, so it
-- must invalidate even though no new timeline row appeared. Keyed on the session
-- that handled the turn, which for a project-scoped conversation is the current
-- orchestrator rather than the conversation's own session.
CREATE TRIGGER conversation_turns_cdc_update
AFTER UPDATE ON conversation_turns
WHEN OLD.state <> NEW.state
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
		   json_object('id', s.id, 'sessionId', s.id, 'conversationId', NEW.conversation_id,
					   'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           COALESCE(NEW.completed_at, NEW.started_at, NEW.requested_at)
    FROM sessions s
    WHERE s.id = NEW.handled_by_session_id;
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS conversation_turns_cdc_update;
DROP TRIGGER IF EXISTS conversation_activities_cdc_update;
DROP TRIGGER IF EXISTS conversation_messages_cdc_update;
DROP TRIGGER IF EXISTS conversation_activities_cdc_insert;
DROP TRIGGER IF EXISTS conversation_messages_cdc_insert;
DROP TABLE IF EXISTS conversation_provider_events;
DROP TABLE IF EXISTS conversation_activities;
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS conversation_turns;
DROP TABLE IF EXISTS conversations;
ALTER TABLE sessions DROP COLUMN controller_generation;
ALTER TABLE sessions DROP COLUMN provider_conversation_id;
ALTER TABLE sessions DROP COLUMN session_mode;
-- +goose StatementEnd
