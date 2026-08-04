package sqlite

import (
	"database/sql"
	"fmt"
)

// healIncompleteChatBaseSchema repairs databases where goose recorded migration
// 0041 (or later) as applied, but the Chat base objects are missing.
//
// That state was observed on upgrade: goose_db_version had 41/42 applied and
// app_settings existed, yet sessions lacked session_mode and the conversations
// tables were absent. The next migration (0043) then fails with
// "no such table: conversations" and the install-build daemon cannot start.
//
// The heal is a no-op when 0041 has not been claimed yet (goose still owns a
// normal Up of 0041) or when the base objects are already present.
func healIncompleteChatBaseSchema(db *sql.DB) error {
	claimed, err := chatBaseSchemaClaimed(db)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}

	if err := ensureSessionChatColumns(db); err != nil {
		return err
	}
	if err := ensureConversationBaseTables(db); err != nil {
		return err
	}
	return ensureConversationBaseTriggers(db)
}

func chatBaseSchemaClaimed(db *sql.DB) (bool, error) {
	var n int
	// goose_db_version may not exist on a brand-new file; treat that as unclaimed.
	err := db.QueryRow(`
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name = 'goose_db_version'
`).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("check goose_db_version: %w", err)
	}
	if n == 0 {
		return false, nil
	}
	// Only heal when 0041 itself is recorded as applied. A later version alone
	// (AllowMissing histories) still needs goose to run the real 0041 file.
	err = db.QueryRow(`
SELECT COUNT(*) FROM goose_db_version
WHERE is_applied = 1 AND version_id = 41
`).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("query chat migration claim: %w", err)
	}
	return n > 0, nil
}

func tableExists(db *sql.DB, name string) (bool, error) {
	var n int
	err := db.QueryRow(`
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name = ?
`, name).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func columnExists(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func ensureSessionChatColumns(db *sql.DB) error {
	for _, col := range []struct {
		name string
		ddl  string
	}{
		{"session_mode", `ALTER TABLE sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'tui'`},
		{"provider_conversation_id", `ALTER TABLE sessions ADD COLUMN provider_conversation_id TEXT NOT NULL DEFAULT ''`},
		{"controller_generation", `ALTER TABLE sessions ADD COLUMN controller_generation TEXT NOT NULL DEFAULT ''`},
	} {
		ok, err := columnExists(db, "sessions", col.name)
		if err != nil {
			return fmt.Errorf("check sessions.%s: %w", col.name, err)
		}
		if ok {
			continue
		}
		if _, err := db.Exec(col.ddl); err != nil {
			return fmt.Errorf("heal sessions.%s: %w", col.name, err)
		}
	}
	return nil
}

func ensureConversationBaseTables(db *sql.DB) error {
	// CREATE TABLE IF NOT EXISTS keeps a partial heal from erroring if one of the
	// conversation tables already exists while another is missing.
	const ddl = `
CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    scope           TEXT NOT NULL CHECK (scope IN ('session', 'project')),
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    latest_sequence INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP NOT NULL,
    CHECK ((scope = 'session' AND session_id IS NOT NULL)
        OR (scope = 'project' AND session_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id)
    WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_project_scope ON conversations(project_id)
    WHERE scope = 'project';

CREATE TABLE IF NOT EXISTS conversation_turns (
    id                     TEXT PRIMARY KEY,
    conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    handled_by_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider_turn_id       TEXT NOT NULL DEFAULT '',
    controller_generation  TEXT NOT NULL DEFAULT '',
    state                  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
    error_message          TEXT NOT NULL DEFAULT '',
    requested_at           TIMESTAMP NOT NULL,
    started_at             TIMESTAMP,
    completed_at           TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_conversation ON conversation_turns(conversation_id, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_provider ON conversation_turns(conversation_id, provider_turn_id)
    WHERE provider_turn_id <> '';

CREATE TABLE IF NOT EXISTS conversation_messages (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id           TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    sequence          INTEGER NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    origin            TEXT NOT NULL CHECK (origin IN ('human', 'automation', 'daemon', 'provider')),
    text              TEXT NOT NULL DEFAULT '',
    streaming          INTEGER NOT NULL DEFAULT 0,
    provider_item_id  TEXT NOT NULL DEFAULT '',
    client_message_id TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMP NOT NULL,
    updated_at        TIMESTAMP NOT NULL,
    UNIQUE (conversation_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_provider_item
    ON conversation_messages(conversation_id, provider_item_id)
    WHERE provider_item_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_client_id
    ON conversation_messages(conversation_id, client_message_id)
    WHERE client_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_conversation_messages_order
    ON conversation_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS conversation_activities (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id           TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    sequence          INTEGER NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    kind              TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'plan', 'reasoning', 'approval', 'usage', 'error', 'system')),
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'pending', 'resolved')),
    summary           TEXT NOT NULL DEFAULT '',
    detail_json       TEXT NOT NULL DEFAULT '',
    request_id        TEXT NOT NULL DEFAULT '',
    provider_item_id  TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMP NOT NULL,
    updated_at        TIMESTAMP NOT NULL,
    UNIQUE (conversation_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_activities_provider_item
    ON conversation_activities(conversation_id, provider_item_id)
    WHERE provider_item_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_activities_request
    ON conversation_activities(conversation_id, request_id)
    WHERE request_id <> '';
CREATE INDEX IF NOT EXISTS idx_conversation_activities_order
    ON conversation_activities(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_conversation_activities_pending
    ON conversation_activities(conversation_id, kind, status);

CREATE TABLE IF NOT EXISTS conversation_provider_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider_event_id  TEXT NOT NULL DEFAULT '',
    method             TEXT NOT NULL,
    payload_json       TEXT NOT NULL,
    received_at        TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_provider_events_dedupe
    ON conversation_provider_events(conversation_id, provider_event_id)
    WHERE provider_event_id <> '';
CREATE INDEX IF NOT EXISTS idx_conversation_provider_events_replay
    ON conversation_provider_events(conversation_id, id);
`
	if _, err := db.Exec(ddl); err != nil {
		return fmt.Errorf("heal conversation base tables: %w", err)
	}
	return nil
}

func ensureConversationBaseTriggers(db *sql.DB) error {
	// Recreate only when missing so a healthy database is not rewritten on every boot.
	for _, name := range []string{
		"conversation_messages_cdc_insert",
		"conversation_activities_cdc_insert",
		"conversation_turns_cdc_update",
	} {
		var n int
		if err := db.QueryRow(`
SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?
`, name).Scan(&n); err != nil {
			return fmt.Errorf("check trigger %s: %w", name, err)
		}
		if n > 0 {
			continue
		}
		var ddl string
		switch name {
		case "conversation_messages_cdc_insert":
			ddl = `
CREATE TRIGGER conversation_messages_cdc_insert
AFTER INSERT ON conversation_messages
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
           json_object('id', s.id, 'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM conversations c
    JOIN sessions s ON s.id = c.session_id
    WHERE c.id = NEW.conversation_id;
END;`
		case "conversation_activities_cdc_insert":
			ddl = `
CREATE TRIGGER conversation_activities_cdc_insert
AFTER INSERT ON conversation_activities
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
           json_object('id', s.id, 'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM conversations c
    JOIN sessions s ON s.id = c.session_id
    WHERE c.id = NEW.conversation_id;
END;`
		case "conversation_turns_cdc_update":
			ddl = `
CREATE TRIGGER conversation_turns_cdc_update
AFTER UPDATE ON conversation_turns
WHEN OLD.state <> NEW.state
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
           json_object('id', s.id, 'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           COALESCE(NEW.completed_at, NEW.started_at, NEW.requested_at)
    FROM sessions s
    WHERE s.id = NEW.handled_by_session_id;
END;`
		}
		if _, err := db.Exec(ddl); err != nil {
			return fmt.Errorf("heal trigger %s: %w", name, err)
		}
	}
	return nil
}
