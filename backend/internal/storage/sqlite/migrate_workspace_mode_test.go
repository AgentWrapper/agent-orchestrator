package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMigration0030UpgradesPopulatedDB proves the workspace_mode column is
// added cleanly to an EXISTING, already-populated sessions table (the daemon's
// live DB on upgrade), not just a from-scratch schema. A session row written
// before 0030 must read back with an empty workspace_mode — the pre-upgrade
// shape the session manager normalizes to worktree, so no running session is
// rug-pulled by the upgrade.
func TestMigration0030UpgradesPopulatedDB(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Stop at 0029: sessions table exists WITHOUT the workspace_mode column.
	upTo(t, db, 29)

	if _, err := db.Exec(
		`INSERT INTO projects (id, path, registered_at) VALUES ('proj', '/tmp/proj', '2026-01-01T00:00:00Z')`,
	); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO sessions (
			id, project_id, num, issue_id, kind, harness, display_name,
			activity_state, activity_last_at, is_terminated,
			branch, workspace_path, runtime_handle_id, runtime_token, agent_session_id, prompt, model,
			preview_url, preview_revision, launched_harnesses, created_at, updated_at
		) VALUES (
			'proj-1', 'proj', 1, '', 'worker', 'claude-code', 'proj #1',
			'active', '2026-01-01T00:00:00Z', 0,
			'ao/proj-1/root', '/ws', '', '', 'agent-x', 'do it', '',
			'', 0, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
		)`,
	); err != nil {
		t.Fatalf("seed pre-upgrade session: %v", err)
	}

	// Apply 0030: ALTER TABLE ADD COLUMN on the populated table must succeed.
	upTo(t, db, 30)

	var mode string
	if err := db.QueryRow(`SELECT workspace_mode FROM sessions WHERE id = 'proj-1'`).Scan(&mode); err != nil {
		t.Fatalf("read workspace_mode after upgrade: %v", err)
	}
	if mode != "" {
		t.Fatalf("pre-upgrade row workspace_mode = %q, want empty string (no rug-pull)", mode)
	}
}
