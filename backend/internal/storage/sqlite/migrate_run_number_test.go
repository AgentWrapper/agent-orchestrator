package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMigration0051BackfillsExistingRuns covers the upgrade path a dogfooding
// daemon actually takes: a database that already holds runs gets the run_number
// column, and every existing run has to come out of it with a number. A run
// left at the column default would collide with the first new run under the
// unique index, which would wedge the next trigger.
func TestMigration0051BackfillsExistingRuns(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Stop just before 0051: pipeline_runs exists, run_number does not.
	upTo(t, db, 50)

	for _, p := range []string{"proj-1", "proj-2"} {
		if _, err := db.Exec(
			`INSERT INTO projects (id, path, registered_at) VALUES (?, ?, '2026-06-01T00:00:00Z')`,
			p, "/tmp/"+p,
		); err != nil {
			t.Fatalf("seed project %s: %v", p, err)
		}
	}

	// Two pipelines in one project plus a same-named pipeline in another, so
	// the backfill's partitioning is exercised rather than a single sequence.
	seed := []struct{ id, project, name, createdAt string }{
		{"run-r2", "proj-1", "review", "2026-06-02T00:00:00Z"},
		{"run-r1", "proj-1", "review", "2026-06-01T00:00:00Z"},
		{"run-r3", "proj-1", "review", "2026-06-03T00:00:00Z"},
		{"run-a1", "proj-1", "audit", "2026-06-05T00:00:00Z"},
		{"run-o1", "proj-2", "review", "2026-06-04T00:00:00Z"},
	}
	for _, r := range seed {
		if _, err := db.Exec(
			`INSERT INTO pipeline_runs (id, project_id, pipeline_id, pipeline_name, subject_kind,
			     status, definition_json, created_at, updated_at)
			 VALUES (?, ?, 'pl-x', ?, 'project', 'succeeded', '{}', ?, ?)`,
			r.id, r.project, r.name, r.createdAt, r.createdAt,
		); err != nil {
			t.Fatalf("seed %s: %v", r.id, err)
		}
	}

	upTo(t, db, 51)

	// Oldest first within each (project, pipeline name), each sequence from 1.
	want := map[string]int{"run-r1": 1, "run-r2": 2, "run-r3": 3, "run-a1": 1, "run-o1": 1}
	for id, n := range want {
		var got int
		if err := db.QueryRow(`SELECT run_number FROM pipeline_runs WHERE id = ?`, id).Scan(&got); err != nil {
			t.Fatalf("read run_number for %s: %v", id, err)
		}
		if got != n {
			t.Errorf("%s run_number = %d, want %d", id, got, n)
		}
	}

	// The unique index is live after the backfill, so a number already handed
	// out cannot be handed out again.
	_, err = db.Exec(
		`INSERT INTO pipeline_runs (id, project_id, pipeline_id, pipeline_name, subject_kind,
		     status, definition_json, run_number, created_at, updated_at)
		 VALUES ('run-dup', 'proj-1', 'pl-x', 'review', 'project', 'pending', '{}', 2,
		         '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')`)
	if err == nil {
		t.Fatal("inserting a duplicate run number succeeded, want a unique-index violation")
	}
}
