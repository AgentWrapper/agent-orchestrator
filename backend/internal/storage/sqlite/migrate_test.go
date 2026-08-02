package sqlite

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestUsageTablesKeepOnlyDurableCollectionState(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	want := map[string][]string{
		"usage_bindings": {
			"id", "session_id", "harness", "native_root_id", "initial_model_id",
			"state", "last_error_code", "first_seen_at", "last_seen_at", "updated_at",
		},
		"usage_sources": {
			"id", "binding_id", "kind", "native_session_id", "subagent_id", "artifact_path",
			"file_identity", "generation", "byte_offset", "parser_state_json", "state",
			"failure_count", "anomaly_count", "next_retry_at", "last_error_code",
			"last_observed_at", "created_at", "updated_at",
		},
		"model_usage_events": {
			"id", "binding_id", "usage_source_id", "project_id", "session_id", "harness",
			"provider", "model_id", "observed_at", "input_tokens", "uncached_input_tokens",
			"cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens",
			"cost_nanos", "pricing_version", "source_event_key", "created_at",
		},
	}
	for table, wantColumns := range want {
		got := tableColumns(t, db, table)
		if !reflect.DeepEqual(got, wantColumns) {
			t.Errorf("%s columns = %v, want %v", table, got, wantColumns)
		}
	}
}

func tableColumns(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("read %s columns: %v", table, err)
	}
	defer func() { _ = rows.Close() }()
	var columns []string
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan %s columns: %v", table, err)
		}
		columns = append(columns, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate %s columns: %v", table, err)
	}
	return columns
}

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

func TestOpenReadOnlyDoesNotCreateDatabase(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "missing")
	if _, err := OpenReadOnly(context.Background(), dataDir); err == nil {
		t.Fatal("OpenReadOnly succeeded for missing database")
	}
	if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("data dir stat err = %v, want not exist", err)
	}
}

func TestOpenReadOnlyDoesNotMigrate(t *testing.T) {
	dataDir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if _, err := db.Exec(`
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    repo_origin_url TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    registered_at TIMESTAMP NOT NULL,
    archived_at TIMESTAMP
);
INSERT INTO projects (id, path, registered_at) VALUES ('alpha', '/repos/alpha', ?);
`, time.Unix(100, 0).UTC()); err != nil {
		_ = db.Close()
		t.Fatalf("seed old schema: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	store, err := OpenReadOnly(context.Background(), dataDir)
	if err != nil {
		t.Fatalf("OpenReadOnly: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	_, err = store.ListProjects(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no such column") {
		t.Fatalf("ListProjects err = %v, want old-schema column failure", err)
	}

	checkDB, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open check db: %v", err)
	}
	defer func() { _ = checkDB.Close() }()

	var schema string
	if err := checkDB.QueryRow(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'",
	).Scan(&schema); err != nil {
		t.Fatalf("read projects schema: %v", err)
	}
	if strings.Contains(schema, "config") || strings.Contains(schema, "kind") {
		t.Fatalf("OpenReadOnly migrated projects schema:\n%s", schema)
	}
}
