package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
)

func TestMigrateRecognizesPreRenumberedAgentSwitchSchema(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 79)

	agentSwitchMigration, err := migrationsFS.ReadFile("migrations/0081_agent_switching.sql")
	if err != nil {
		t.Fatalf("read agent-switch migration: %v", err)
	}
	finalHandoffMigration, err := migrationsFS.ReadFile("migrations/0082_finalized_agent_handoff.sql")
	if err != nil {
		t.Fatalf("read finalized-handoff migration: %v", err)
	}
	goose.SetBaseFS(fstest.MapFS{
		"migrations/0080_agent_switching.sql":         {Data: agentSwitchMigration},
		"migrations/0081_finalized_agent_handoff.sql": {Data: finalHandoffMigration},
	})
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set goose dialect: %v", err)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		t.Fatalf("apply pre-renumbered agent-switch migrations: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate pre-renumbered agent-switch database: %v", err)
	}
	for _, version := range []int64{80, 81, 82} {
		var applied int
		if err := db.QueryRow(`
SELECT COALESCE((
    SELECT is_applied FROM goose_db_version
    WHERE version_id = ? ORDER BY id DESC LIMIT 1
), 0)`, version).Scan(&applied); err != nil {
			t.Fatalf("read migration %d: %v", version, err)
		}
		if applied != 1 {
			t.Fatalf("migration %d applied = %d, want 1", version, applied)
		}
	}
	if got, err := reviewHasSessionHarnessUnique(db); err != nil || !got {
		t.Fatalf("review per-harness shape = %v, err = %v", got, err)
	}
	for _, column := range []string{"final_handoff_path", "final_handoff_hash"} {
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info('agent_switches') WHERE name = ?`, column,
		).Scan(&count); err != nil {
			t.Fatalf("read agent_switches.%s: %v", column, err)
		}
		if count != 1 {
			t.Fatalf("agent_switches.%s count = %d, want 1", column, count)
		}
	}

	if err := migrate(db); err != nil {
		t.Fatalf("second migration pass: %v", err)
	}
}
