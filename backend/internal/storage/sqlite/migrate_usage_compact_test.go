package sqlite

import (
	"reflect"
	"testing"
	"time"
)

func TestMigrateCompactsLegacyUsageTablesWithoutLosingEvents(t *testing.T) {
	db := openMigratedTestDB(t)

	now := time.Unix(1_700_000_000, 0).UTC()
	if _, err := db.Exec(`
		INSERT INTO projects (id, path, registered_at)
		VALUES ('project-1', '/tmp/project-1', ?);
		INSERT INTO sessions (
			id, project_id, num, harness, activity_last_at, created_at, updated_at
		) VALUES ('session-1', 'project-1', 1, 'codex', ?, ?, ?);
	`, now, now, now, now); err != nil {
		t.Fatalf("seed parents: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO usage_bindings (
			id, session_id, harness, native_root_id, initial_model_id, state,
			first_seen_at, last_seen_at, updated_at
		) VALUES (1, 'session-1', 'codex', 'native-1', 'gpt-test', 'active', ?, ?, ?);

		INSERT INTO usage_sources (
			id, binding_id, kind, native_session_id, artifact_path, file_identity,
			generation, byte_offset, parser_state_json, state, created_at, updated_at
		) VALUES (1, 1, 'codex_rollout', 'native-1', '/tmp/rollout.jsonl', 'file-1',
			0, 128, '{"version":2,"sourceKind":"codex_rollout"}', 'active', ?, ?);
		INSERT INTO usage_sources (
			id, binding_id, kind, native_session_id, artifact_path, state,
			last_error_code, created_at, updated_at
		) VALUES (2, 1, 'codex_rollout', 'native-retired', '/tmp/retired.jsonl',
			'complete', 'artifact_replaced', ?, ?);

		INSERT INTO model_usage_events (
			id, binding_id, usage_source_id, project_id, session_id, harness,
			provider, model_id, observed_at, input_tokens, uncached_input_tokens,
			cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
			source_event_key, created_at
		) VALUES (1, 1, 1, 'project-1', 'session-1', 'codex',
			'openai', 'gpt-test', ?, 100, 60, 40, 0, 25, 5,
			'event-1', ?);

		ALTER TABLE usage_bindings
			ADD COLUMN source_cli_version TEXT NOT NULL DEFAULT '';
		ALTER TABLE usage_sources
			ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'v1';
		ALTER TABLE model_usage_events
			ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'v1';
	`, now, now, now, now, now, now, now, now); err != nil {
		t.Fatalf("seed widened usage schema: %v", err)
	}

	if _, err := db.Exec(`
		DROP VIEW usage_codex_pending_children;
		DROP VIEW usage_codex_source_discovery;
		DELETE FROM goose_db_version WHERE version_id IN (46, 47);
	`); err != nil {
		t.Fatalf("rewind compaction migration: %v", err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("migrate legacy usage schema: %v", err)
	}

	for table, want := range expectedUsageTableColumns {
		if got := tableColumns(t, db, table); !reflect.DeepEqual(got, want) {
			t.Errorf("%s columns = %v, want %v", table, got, want)
		}
	}

	var (
		eventCount  int
		inputTokens int64
		parserState string
	)
	if err := db.QueryRow(`SELECT COUNT(*), SUM(input_tokens) FROM model_usage_events`).Scan(&eventCount, &inputTokens); err != nil {
		t.Fatalf("read migrated usage events: %v", err)
	}
	if eventCount != 1 || inputTokens != 100 {
		t.Fatalf("migrated usage = (%d events, %d input tokens), want (1, 100)", eventCount, inputTokens)
	}
	if err := db.QueryRow(`SELECT parser_state_json FROM usage_sources WHERE id = 1`).Scan(&parserState); err != nil {
		t.Fatalf("read migrated parser state: %v", err)
	}
	if parserState != `{"version":2,"sourceKind":"codex_rollout"}` {
		t.Fatalf("parser state = %q", parserState)
	}
	var retiredCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage_sources WHERE id = 2`).Scan(&retiredCount); err != nil {
		t.Fatalf("count retired source: %v", err)
	}
	if retiredCount != 0 {
		t.Fatalf("retired eventless source count = %d, want 0", retiredCount)
	}

	if _, err := db.Exec(`
		INSERT INTO usage_sources (
			binding_id, kind, native_session_id, artifact_path, state, created_at, updated_at
		) VALUES (1, 'codex_rollout', 'native-2', '/tmp/new-rollout.jsonl', 'pending', ?, ?)
	`, now, now); err != nil {
		t.Fatalf("insert compact usage source: %v", err)
	}
}
