package sqlite

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestModelUsageEventsHasUsageSourceIndex(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}

	indexColumns, err := db.Query(`PRAGMA index_info('idx_model_usage_events_usage_source')`)
	if err != nil {
		t.Fatal(err)
	}
	defer indexColumns.Close()
	if !indexColumns.Next() {
		t.Fatal("idx_model_usage_events_usage_source has no columns")
	}
	var (
		sequence int
		columnID int
		column   string
	)
	if err := indexColumns.Scan(&sequence, &columnID, &column); err != nil {
		t.Fatal(err)
	}
	if column != "usage_source_id" {
		t.Fatalf("indexed column = %q, want usage_source_id", column)
	}
	if indexColumns.Next() {
		t.Fatal("idx_model_usage_events_usage_source has unexpected extra columns")
	}
	if err := indexColumns.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestUsageSourcesHasLatestCodexNativeIndex(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}

	const indexName = "idx_usage_sources_codex_native_latest"
	rows, err := db.Query(`PRAGMA index_xinfo('` + indexName + `')`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var columns []string
	var descending []int
	for rows.Next() {
		var (
			sequence int
			columnID int
			column   *string
			desc     int
			coll     string
			key      int
		)
		if err := rows.Scan(&sequence, &columnID, &column, &desc, &coll, &key); err != nil {
			t.Fatal(err)
		}
		if key == 1 && column != nil {
			columns = append(columns, *column)
			descending = append(descending, desc)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"kind", "native_session_id", "binding_id", "generation", "id"}; !reflect.DeepEqual(columns, want) {
		t.Fatalf("index columns = %v, want %v", columns, want)
	}
	if want := []int{0, 0, 0, 1, 1}; !reflect.DeepEqual(descending, want) {
		t.Fatalf("index descending flags = %v, want %v", descending, want)
	}

	planRows, err := db.Query(`
		EXPLAIN QUERY PLAN
		SELECT latest.id
		FROM usage_sources latest
		WHERE latest.kind = 'codex_rollout'
		  AND latest.native_session_id = ?
		  AND latest.binding_id = ?
		ORDER BY latest.generation DESC, latest.id DESC
		LIMIT 1
	`, "22222222-2222-4222-8222-222222222222", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = planRows.Close() }()
	var details []string
	for planRows.Next() {
		var id, parent, unused int
		var detail string
		if err := planRows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		details = append(details, detail)
	}
	if err := planRows.Err(); err != nil {
		t.Fatal(err)
	}
	plan := strings.Join(details, "\n")
	if !strings.Contains(plan, indexName) || strings.Contains(plan, "USE TEMP B-TREE") {
		t.Fatalf("latest Codex lookup plan did not use %s:\n%s", indexName, plan)
	}
}
