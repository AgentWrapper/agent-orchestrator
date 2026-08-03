package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigration0042BackfillsReviewerGenerationFromExistingHandle(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 38)
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disable foreign keys for isolated review seed: %v", err)
	}
	if _, err := db.Exec(`
INSERT INTO review (
    id, session_id, project_id, harness, reviewer_handle_id, created_at, updated_at
) VALUES (
    'review-1', 'session-1', 'project-1', 'codex', 'review-session-1',
    '2026-07-30T10:00:00Z', '2026-07-30T10:00:00Z'
);
INSERT INTO review_run (
    id, review_id, session_id, batch_id, harness, pr_url, target_sha,
    status, verdict, body, created_at
) VALUES
    (
        'run-launched', 'review-1', 'session-1', 'batch-launched', 'codex',
        'https://example.test/pr/1', 'sha-old', 'complete', 'approved', '',
        '2026-07-30T10:00:00Z'
    ),
    (
        'run-never-launched', 'review-1', 'session-1', 'batch-never-launched', 'codex',
        'https://example.test/pr/1', 'sha-new', 'failed', '', 'notify failed',
        '2026-07-30T11:00:00Z'
    );
`); err != nil {
		t.Fatalf("seed pre-0042 reviewer state: %v", err)
	}

	upTo(t, db, 42)
	var applied int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM goose_db_version WHERE version_id = 42 AND is_applied = 1`,
	).Scan(&applied); err != nil {
		t.Fatalf("read reviewer generation migration version: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied migration version 42 count = %d, want 1", applied)
	}

	var generation string
	if err := db.QueryRow(
		`SELECT reviewer_generation FROM review WHERE id = 'review-1'`,
	).Scan(&generation); err != nil {
		t.Fatalf("read reviewer generation: %v", err)
	}
	if generation != "review-session-1" {
		t.Fatalf(
			"reviewer generation = %q, want stable token from existing handle",
			generation,
		)
	}
}
