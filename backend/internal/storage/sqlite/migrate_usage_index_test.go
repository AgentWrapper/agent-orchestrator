package sqlite

import (
	"database/sql"
	"path/filepath"
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

	rows, err := db.Query(`PRAGMA index_list('model_usage_events')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	found := false
	for rows.Next() {
		var (
			sequence int
			name     string
			unique   int
			origin   string
			partial  int
		)
		if err := rows.Scan(&sequence, &name, &unique, &origin, &partial); err != nil {
			t.Fatal(err)
		}
		if name == "idx_model_usage_events_usage_source" {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("idx_model_usage_events_usage_source is missing")
	}
	if err := rows.Close(); err != nil {
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
