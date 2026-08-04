package sqlite

import (
	"testing"
	"time"
)

// Mirrors the production failure that blocked packaged-app startup: goose has
// already recorded 0041/0042, app_settings exists, but conversation tables and
// session chat columns were never created. migrate() must heal that hole and
// then finish later chat migrations.
func TestMigrateHealsClaimedButMissingChatBaseSchema(t *testing.T) {
	db := openTestDB(t)
	upTo(t, db, 40)

	now := time.Now().UTC()
	if _, err := db.Exec(`INSERT INTO projects (id, path, display_name, registered_at)
		VALUES ('p1', '/tmp/p1', 'proj', ?)`, now); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, project_id, num, kind, activity_state, activity_last_at, is_terminated, created_at, updated_at)
		VALUES ('ao-1', 'p1', 1, 'worker', 'idle', ?, 0, ?, ?)`, now, now, now); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	// Claim 0041/0042 the way a damaged install history did: version rows and
	// 0042's table without any 0041 objects.
	if _, err := db.Exec(`INSERT INTO goose_db_version (version_id, is_applied, tstamp) VALUES (41, 1, ?)`, now); err != nil {
		t.Fatalf("claim 41: %v", err)
	}
	if _, err := db.Exec(`
CREATE TABLE app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_session_mode TEXT NOT NULL DEFAULT 'tui'
        CHECK (default_session_mode IN ('chat', 'tui')),
    updated_at TIMESTAMP NOT NULL
)`); err != nil {
		t.Fatalf("create app_settings: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_settings (id, default_session_mode, updated_at) VALUES (1, 'tui', ?)`, now); err != nil {
		t.Fatalf("seed app_settings: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO goose_db_version (version_id, is_applied, tstamp) VALUES (42, 1, ?)`, now); err != nil {
		t.Fatalf("claim 42: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate damaged chat history: %v", err)
	}

	for _, table := range []string{
		"conversations",
		"conversation_turns",
		"conversation_messages",
		"conversation_activities",
		"conversation_provider_events",
	} {
		ok, err := tableExists(db, table)
		if err != nil {
			t.Fatalf("tableExists %s: %v", table, err)
		}
		if !ok {
			t.Fatalf("expected table %s after heal", table)
		}
	}

	for _, col := range []string{"session_mode", "provider_conversation_id", "controller_generation"} {
		ok, err := columnExists(db, "sessions", col)
		if err != nil {
			t.Fatalf("columnExists sessions.%s: %v", col, err)
		}
		if !ok {
			t.Fatalf("expected sessions.%s after heal", col)
		}
	}

	var mode string
	if err := db.QueryRow(`SELECT session_mode FROM sessions WHERE id = 'ao-1'`).Scan(&mode); err != nil {
		t.Fatalf("read backfilled session_mode: %v", err)
	}
	if mode != "tui" {
		t.Fatalf("healed session_mode = %q, want tui", mode)
	}

	// Later additive chat migrations must be able to run after the heal.
	ok, err := columnExists(db, "conversations", "model")
	if err != nil {
		t.Fatalf("columnExists conversations.model: %v", err)
	}
	if !ok {
		t.Fatal("expected conversations.model from 0043 after heal+migrate")
	}

	// Idempotent: a second migrate must not fail on the healed schema.
	if err := migrate(db); err != nil {
		t.Fatalf("repeat migrate after heal: %v", err)
	}
}

// A clean database that has never claimed 0041 must still rely on goose, not
// the heal path, for creating Chat objects.
func TestMigrateDoesNotHealBeforeChatMigrationClaimed(t *testing.T) {
	db := openTestDB(t)
	upTo(t, db, 40)

	ok, err := tableExists(db, "conversations")
	if err != nil {
		t.Fatalf("tableExists: %v", err)
	}
	if ok {
		t.Fatal("conversations should not exist before 0041")
	}

	// Heal alone must no-op when goose has not claimed chat migrations.
	if err := healIncompleteChatBaseSchema(db); err != nil {
		t.Fatalf("heal before claim: %v", err)
	}
	ok, err = tableExists(db, "conversations")
	if err != nil {
		t.Fatalf("tableExists after no-op heal: %v", err)
	}
	if ok {
		t.Fatal("heal created conversations before 0041 was claimed")
	}
}
