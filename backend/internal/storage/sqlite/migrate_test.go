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

	harnesses := []domain.AgentHarness{
		domain.HarnessClaudeCode,
		domain.HarnessCodex,
		domain.HarnessAider,
		domain.HarnessOpenCode,
		domain.HarnessGrok,
		domain.HarnessDroid,
		domain.HarnessAmp,
		domain.HarnessAgy,
		domain.HarnessCrush,
		domain.HarnessCursor,
		domain.HarnessQwen,
		domain.HarnessCopilot,
		domain.HarnessGoose,
		domain.HarnessAuggie,
		domain.HarnessContinue,
		domain.HarnessDevin,
		domain.HarnessCline,
		domain.HarnessKimi,
		domain.HarnessKiro,
		domain.HarnessKilocode,
		domain.HarnessVibe,
		domain.HarnessPi,
		domain.HarnessAutohand,
	}

	for _, h := range harnesses {
		if !strings.Contains(schema, "'"+string(h)+"'") {
			t.Errorf("sessions.harness CHECK is missing harness %q — the migration that widens it silently no-opped; schema:\n%s", h, schema)
		}
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
