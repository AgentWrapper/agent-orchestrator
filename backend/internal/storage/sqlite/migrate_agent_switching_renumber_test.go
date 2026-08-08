package sqlite

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
)

func TestMigrateRecognizesAgentSwitchSchemaFromVersions0080And0081(t *testing.T) {
	db := openAgentSwitchMigrationTestDB(t)
	upTo(t, db, 79)
	applyLegacyAgentSwitchMigrations(t, db, "migrations/0080_agent_switching.sql", "migrations/0081_finalized_agent_handoff.sql")
	assertAgentSwitchMigrationHistoryRepaired(t, db, false)
}

func TestMigrateRecognizesAgentSwitchSchemaFromVersions0081And0082(t *testing.T) {
	db := openAgentSwitchMigrationTestDB(t)
	upTo(t, db, 80)
	applyLegacyAgentSwitchMigrations(t, db, "migrations/0081_agent_switching.sql", "migrations/0082_finalized_agent_handoff.sql")
	assertAgentSwitchMigrationHistoryRepaired(t, db, false)
}

func TestMigrateRecognizesPreConsolidationAgentSwitchSchemaFromVersions0083And0084(t *testing.T) {
	db := openAgentSwitchMigrationTestDB(t)
	upTo(t, db, 82)
	applyLegacyAgentSwitchMigrations(t, db, "migrations/0083_agent_switching.sql", "migrations/0084_finalized_agent_handoff.sql")
	assertAgentSwitchMigrationHistoryRepaired(t, db, true)
}

func TestMigrateRepairsPreConsolidationAgentSwitchBaseWithoutFinalHandoffMigration(t *testing.T) {
	db := openAgentSwitchMigrationTestDB(t)
	upTo(t, db, 82)
	applyLegacyAgentSwitchMigrations(t, db, "migrations/0083_agent_switching.sql", "")
	assertAgentSwitchMigrationHistoryRepaired(t, db, false)
}

func openAgentSwitchMigrationTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func applyLegacyAgentSwitchMigrations(t *testing.T, db *sql.DB, switchPath, handoffPath string) {
	t.Helper()
	agentSwitchMigration, err := migrationsFS.ReadFile("migrations/0083_agent_switching.sql")
	if err != nil {
		t.Fatalf("read agent-switch migration: %v", err)
	}
	// Reconstruct the exact pre-consolidation table shape. The historical 0084
	// below then adds only the two finalized-handoff columns, leaving transcript
	// status for the compatibility repair to add.
	legacyAgentSwitchMigration := strings.ReplaceAll(string(agentSwitchMigration), `    source_transcript_status   TEXT NOT NULL DEFAULT 'not_attempted'
        CHECK (source_transcript_status IN ('not_attempted', 'available', 'unavailable')),
`, "")
	legacyAgentSwitchMigration = strings.ReplaceAll(legacyAgentSwitchMigration, `    semantic_handoff_included INTEGER NOT NULL DEFAULT 0
        CHECK (semantic_handoff_included IN (0, 1)),
`, "")
	legacyAgentSwitchMigration = strings.ReplaceAll(legacyAgentSwitchMigration, `    final_handoff_path         TEXT NOT NULL DEFAULT '',
    final_handoff_hash         TEXT NOT NULL DEFAULT '',
`, "")
	if legacyAgentSwitchMigration == string(agentSwitchMigration) ||
		strings.Contains(legacyAgentSwitchMigration, "source_transcript_status") ||
		strings.Contains(legacyAgentSwitchMigration, "semantic_handoff_included") ||
		strings.Contains(legacyAgentSwitchMigration, "final_handoff_path") ||
		strings.Contains(legacyAgentSwitchMigration, "final_handoff_hash") {
		t.Fatal("pre-consolidation fixture did not remove the consolidated agent-switch columns")
	}
	legacyFS := fstest.MapFS{
		switchPath: {Data: []byte(legacyAgentSwitchMigration)},
	}
	if handoffPath != "" {
		legacyFS[handoffPath] = &fstest.MapFile{Data: []byte(preConsolidationFinalHandoffMigration)}
	}
	goose.SetBaseFS(legacyFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set goose dialect: %v", err)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		t.Fatalf("apply legacy agent-switch migrations: %v", err)
	}
}

func assertAgentSwitchMigrationHistoryRepaired(t *testing.T, db *sql.DB, expectBurned84 bool) {
	t.Helper()
	if err := migrate(db); err != nil {
		t.Fatalf("migrate legacy agent-switch database: %v", err)
	}
	for _, version := range []int64{80, 81, 82, 83} {
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
	var applied84 int
	if err := db.QueryRow(`
SELECT COALESCE((
    SELECT is_applied FROM goose_db_version
    WHERE version_id = 84 ORDER BY id DESC LIMIT 1
), 0)`).Scan(&applied84); err != nil {
		t.Fatalf("read migration 84: %v", err)
	}
	if (applied84 == 1) != expectBurned84 {
		t.Fatalf("migration 84 applied = %d, want retained=%v", applied84, expectBurned84)
	}
	if got, err := reviewHasSessionHarnessUnique(db); err != nil || !got {
		t.Fatalf("review per-harness shape = %v, err = %v", got, err)
	}
	for table, column := range map[string]string{
		"sessions":                         "browser_capability_verifier",
		"agent_switches.final_path":        "final_handoff_path",
		"agent_switches.final_hash":        "final_handoff_hash",
		"agent_switches.transcript_status": "source_transcript_status",
		"agent_switches.semantic_included": "semantic_handoff_included",
	} {
		tableName := strings.SplitN(table, ".", 2)[0]
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, tableName, column,
		).Scan(&count); err != nil {
			t.Fatalf("read %s.%s: %v", table, column, err)
		}
		if count != 1 {
			t.Fatalf("%s.%s count = %d, want 1", table, column, count)
		}
	}
	var primeHarnessShape int
	if err := db.QueryRow(`
SELECT COUNT(*)
FROM sqlite_master
WHERE type = 'table'
  AND name = 'sessions'
  AND instr(COALESCE(sql, ''), '''prime-agent''') > 0`).Scan(&primeHarnessShape); err != nil {
		t.Fatalf("read Prime Agent session shape: %v", err)
	}
	if primeHarnessShape != 1 {
		t.Fatalf("Prime Agent session shape = %d, want 1", primeHarnessShape)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("second migration pass: %v", err)
	}
}

const preConsolidationFinalHandoffMigration = `
-- +goose Up
-- +goose StatementBegin
ALTER TABLE agent_switches ADD COLUMN final_handoff_path TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE agent_switches ADD COLUMN final_handoff_hash TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE agent_switches DROP COLUMN final_handoff_hash;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE agent_switches DROP COLUMN final_handoff_path;
-- +goose StatementEnd
`
