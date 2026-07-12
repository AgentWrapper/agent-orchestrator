package sqlite

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestMigrateAllowsEveryShippedHarness guards against the collapsed-migration
// silent-no-op concern: a hand-written replace() that fails to widen the
// sessions.harness CHECK (because the target substring drifted) leaves the
// schema accepting only the original harnesses while migrate() still reports
// success. This test opens a fresh DB, runs the migrations, and asserts the
// live sessions schema admits every harness the domain ships, building the
// expected set from the domain constants so it can't silently drift.
func TestMigrateAllowsEveryShippedHarness(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var schema string
	if err := db.QueryRow(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
	).Scan(&schema); err != nil {
		t.Fatalf("read sessions schema: %v", err)
	}

	for _, h := range domain.AllHarnesses {
		if !strings.Contains(schema, "'"+string(h)+"'") {
			t.Errorf("sessions.harness CHECK is missing harness %q — the migration that widens it silently no-opped; schema:\n%s", h, schema)
		}
	}
}

func TestMigrateIsIdempotentOnCurrentSchema(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := migrate(db); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	for _, version := range []int64{33, 34, 39, 40} {
		applied, err := gooseVersionApplied(db, version)
		if err != nil {
			t.Fatalf("check goose version %d: %v", version, err)
		}
		if !applied {
			t.Fatalf("goose version %d not applied after repeated migrate", version)
		}
	}
	assertSQLiteColumn(t, db, "notifications", "head_sha")
	assertSQLiteColumn(t, db, "sessions", "pending_decision")
}

func TestMigrateAllowsPrimeSessionKindAndSingleton(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var schema string
	if err := db.QueryRow(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
	).Scan(&schema); err != nil {
		t.Fatalf("read sessions schema: %v", err)
	}
	if !strings.Contains(schema, "'prime'") {
		t.Fatalf("sessions.kind CHECK is missing prime; schema:\n%s", schema)
	}

	if _, err := db.Exec(`INSERT INTO projects (id, path, registered_at) VALUES ('ao', '/tmp/ao', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, project_id, num, kind, harness, activity_state, is_terminated, activity_last_at, created_at, updated_at) VALUES ('prime-1', 'ao', 1, 'prime', 'claude-code', 'idle', FALSE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("insert first live prime: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, project_id, num, kind, harness, activity_state, is_terminated, activity_last_at, created_at, updated_at) VALUES ('prime-2', 'ao', 2, 'prime', 'claude-code', 'idle', FALSE, '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z')`); err == nil {
		t.Fatal("insert second live prime succeeded; want singleton constraint")
	}
}

func TestMigrateHandlesDivergentVersion32HeadSHAHistory(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 31)
	if _, err := db.Exec(`ALTER TABLE notifications ADD COLUMN head_sha TEXT NOT NULL DEFAULT ''`); err != nil {
		t.Fatalf("simulate old version 32 head_sha migration: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO goose_db_version (version_id, is_applied) VALUES (32, 1)`); err != nil {
		t.Fatalf("record old version 32: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate divergent version 32 db: %v", err)
	}
	assertSQLiteColumn(t, db, "notifications", "head_sha")
	assertSQLiteColumn(t, db, "sessions", "pending_decision")
	for _, version := range []int64{33, 34, 35} {
		applied, err := gooseVersionApplied(db, version)
		if err != nil {
			t.Fatalf("check goose version %d: %v", version, err)
		}
		if !applied {
			t.Fatalf("goose version %d not marked applied after compatibility migration", version)
		}
	}
}

func TestMainCIRedMigrationPreservesWorkerTerminalDedupeIndex(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 42)
	assertWorkerTerminalDedupeIndex(t, db)

	downTo(t, db, 41)
	assertWorkerTerminalDedupeIndex(t, db)
}

func TestNotificationsMigrationUsesTypedSubjectsAndOpenTypeSchema(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	assertSQLiteColumn(t, db, "notifications", "subject_kind")
	assertSQLiteColumn(t, db, "notifications", "subject_id")

	var schema string
	if err := db.QueryRow(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'",
	).Scan(&schema); err != nil {
		t.Fatalf("read notifications schema: %v", err)
	}
	if strings.Contains(schema, "type IN") {
		t.Fatalf("notifications.type still has a closed SQL enum CHECK; schema:\n%s", schema)
	}

	if _, err := db.Exec(`INSERT INTO projects (id, path, registered_at) VALUES ('ao', '/tmp/ao', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO notifications (id, project_id, type, title, status, created_at, subject_kind, subject_id)
		VALUES ('future-type', 'ao', 'future_notification_type', 'future', 'unread', '2026-07-12T00:00:00Z', 'project', 'ao')
	`); err != nil {
		t.Fatalf("insert future notification type through SQL schema: %v", err)
	}
}

func downTo(t *testing.T, db *sql.DB, version int64) {
	t.Helper()
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	if err := goose.DownTo(db, "migrations", version); err != nil {
		t.Fatalf("migrate down to %d: %v", version, err)
	}
}

func assertSQLiteColumn(t *testing.T, db *sql.DB, table, column string) {
	t.Helper()
	ok, err := sqliteColumnExists(db, table, column)
	if err != nil {
		t.Fatalf("check %s.%s: %v", table, column, err)
	}
	if !ok {
		t.Fatalf("missing column %s.%s", table, column)
	}
}

func assertWorkerTerminalDedupeIndex(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disable foreign keys for raw notification index assertion: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM notifications`); err != nil {
		t.Fatalf("clear notifications: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO notifications (id, session_id, project_id, type, title, status, created_at)
		VALUES ('terminal-1', 'session-1', 'project-1', 'worker_died_unfinished', 'worker died', 'read', '2026-07-11T00:00:00Z')
	`); err != nil {
		t.Fatalf("insert first terminal notification: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO notifications (id, session_id, project_id, type, title, status, created_at)
		VALUES ('terminal-2', 'session-1', 'project-1', 'worker_died_unfinished', 'worker died again', 'unread', '2026-07-11T00:01:00Z')
	`); err == nil {
		t.Fatal("worker terminal dedupe index allowed duplicate session/type notification")
	}
}

func TestProjectConfigCDCMigrationPreservesChangeLogHighWaterMark(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 30)
	if _, err := db.Exec(
		`INSERT INTO projects (id, path, registered_at) VALUES ('p1', '/tmp/p1', '2026-01-01T00:00:00Z')`,
	); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	for i := 0; i < 5; i++ {
		if _, err := db.Exec(
			`INSERT INTO change_log (project_id, event_type, payload) VALUES ('p1', 'session_updated', '{}')`,
		); err != nil {
			t.Fatalf("seed change_log row %d: %v", i+1, err)
		}
	}
	if _, err := db.Exec(`DELETE FROM change_log WHERE seq IN (4, 5)`); err != nil {
		t.Fatalf("delete tail rows: %v", err)
	}

	upTo(t, db, 31)
	assertSQLiteSequence(t, db, "change_log", 5)
	assertNextChangeLogSeq(t, db, 6)

	if _, err := db.Exec(`DELETE FROM change_log WHERE seq = 6`); err != nil {
		t.Fatalf("delete post-upgrade row: %v", err)
	}
	downTo(t, db, 30)
	assertSQLiteSequence(t, db, "change_log", 6)
	assertNextChangeLogSeq(t, db, 7)
}

func TestProjectConfigCDCTriggersSkipMalformedLegacyConfig(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 30)
	if _, err := db.Exec(
		`INSERT INTO projects (id, path, registered_at, config) VALUES ('p1', '/tmp/p1', '2026-01-01T00:00:00Z', 'not-json')`,
	); err != nil {
		t.Fatalf("seed corrupt project config: %v", err)
	}

	upTo(t, db, 31)
	if _, err := db.Exec(`UPDATE projects SET config = '{"defaultBranch":"main"}' WHERE id = 'p1'`); err != nil {
		t.Fatalf("repair corrupt project config: %v", err)
	}
	assertProjectConfigChangeLogCount(t, db, 0)

	if _, err := db.Exec(`UPDATE projects SET config = '{"defaultBranch":"release"}' WHERE id = 'p1'`); err != nil {
		t.Fatalf("update valid project config: %v", err)
	}
	assertProjectConfigChangeLogCount(t, db, 1)
}

func assertProjectConfigChangeLogCount(t *testing.T, db *sql.DB, want int64) {
	t.Helper()
	var got int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM change_log WHERE event_type = 'project_config_changed'`).Scan(&got); err != nil {
		t.Fatalf("count project_config_changed events: %v", err)
	}
	if got != want {
		t.Fatalf("project_config_changed count = %d, want %d", got, want)
	}
}

func assertSQLiteSequence(t *testing.T, db *sql.DB, table string, want int64) {
	t.Helper()
	var got int64
	if err := db.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name = ?`, table).Scan(&got); err != nil {
		t.Fatalf("read sqlite_sequence for %s: %v", table, err)
	}
	if got != want {
		t.Fatalf("sqlite_sequence[%s] = %d, want %d", table, got, want)
	}
}

func assertNextChangeLogSeq(t *testing.T, db *sql.DB, want int64) {
	t.Helper()
	res, err := db.Exec(`INSERT INTO change_log (project_id, event_type, payload) VALUES ('p1', 'session_updated', '{}')`)
	if err != nil {
		t.Fatalf("insert change_log row: %v", err)
	}
	got, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	if got != want {
		t.Fatalf("next change_log seq = %d, want %d", got, want)
	}
}
