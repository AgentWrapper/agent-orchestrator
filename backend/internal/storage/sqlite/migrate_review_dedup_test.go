package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/pressly/goose/v3"
)

// upTo migrates the db to a specific goose version, sharing migrate()'s goose
// global setup under gooseMu.
func upTo(t *testing.T, db *sql.DB, version int64) {
	t.Helper()
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	if err := goose.UpTo(db, "migrations", version); err != nil {
		t.Fatalf("migrate to %d: %v", version, err)
	}
}

// TestMigration0013DedupesExistingDuplicates guards the data-safety concern in
// #246: a pre-#242 daemon could already hold duplicate (session_id, target_sha)
// review_run rows, on which CREATE UNIQUE INDEX would fail and wedge startup. The
// migration must collapse each group to one survivor first. We open without the
// foreign_keys pragma so review_run rows can be seeded without the full
// project/session/review parent chain — the dedup is pure data movement.
func TestMigration0013DedupesExistingDuplicates(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Stop just before 0013: review tables exist, the unique index does not.
	upTo(t, db, 12)

	// One duplicate group on shaA (a stale run, a completed pass carrying the
	// verdict, and a newer still-running pass), plus a distinct sha and two
	// empty-sha rows that the partial index excludes and must all survive.
	seed := []struct{ id, sha, status, createdAt string }{
		{"r-old", "shaA", "running", "2026-06-01T00:00:00Z"},
		{"r-complete", "shaA", "complete", "2026-06-02T00:00:00Z"},
		{"r-new-running", "shaA", "running", "2026-06-03T00:00:00Z"},
		{"r-other-sha", "shaB", "running", "2026-06-01T00:00:00Z"},
		{"r-empty-1", "", "running", "2026-06-01T00:00:00Z"},
		{"r-empty-2", "", "running", "2026-06-02T00:00:00Z"},
	}
	for _, r := range seed {
		if _, err := db.Exec(
			`INSERT INTO review_run (id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at)
			 VALUES (?, 'rev-1', 's1', 'claude-code', '', ?, ?, '', '', ?)`,
			r.id, r.sha, r.status, r.createdAt,
		); err != nil {
			t.Fatalf("seed %s: %v", r.id, err)
		}
	}

	// Applying 0013 dedupes, then builds the unique index.
	upTo(t, db, 13)

	survivors := map[string]bool{}
	rows, err := db.Query(`SELECT id FROM review_run`)
	if err != nil {
		t.Fatalf("query survivors: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		survivors[id] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	// shaA collapses to the completed pass; everything else is untouched.
	want := []string{"r-complete", "r-other-sha", "r-empty-1", "r-empty-2"}
	if len(survivors) != len(want) {
		t.Fatalf("survivors = %v, want exactly %v", survivors, want)
	}
	for _, id := range want {
		if !survivors[id] {
			t.Errorf("expected %q to survive the dedup", id)
		}
	}

	// The index is live and now rejects a fresh duplicate.
	if _, err := db.Exec(
		`INSERT INTO review_run (id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at)
		 VALUES ('dup', 'rev-1', 's1', 'claude-code', '', 'shaA', 'running', '', '', '2026-06-04T00:00:00Z')`,
	); err == nil {
		t.Fatal("expected unique-index violation inserting a duplicate (session_id, target_sha)")
	}
}

func TestMigration0044BackfillsBatchlessReviewRuns(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 43)
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disable foreign keys: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO review_run (id, review_id, session_id, harness, pr_url, target_sha, status, verdict, body, created_at)
		 VALUES ('run-1', 'review-1', 'session-1', 'claude-code', 'pr1', 'sha1', 'running', '', '', '2026-06-01T00:00:00Z')`,
	); err != nil {
		t.Fatalf("seed batchless review run: %v", err)
	}

	upTo(t, db, 44)
	var batchID string
	if err := db.QueryRow(`SELECT batch_id FROM review_run WHERE id = 'run-1'`).Scan(&batchID); err != nil {
		t.Fatalf("query migrated batch id: %v", err)
	}
	if batchID != "run-1" {
		t.Fatalf("batch_id = %q, want run id", batchID)
	}
}
