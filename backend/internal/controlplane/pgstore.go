package controlplane

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib" // Postgres driver via database/sql

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud"
)

// PostgresStore is the control plane's cloud-session registry, backed by
// Postgres — the SAME engine locally (Docker) and in Azure (managed Postgres),
// so there is one code path and one SQL dialect (no dev/prod drift). It
// implements cloud.Store; nothing above the cloud.Store interface (supervisor,
// HTTP handlers, auth) knows or cares which engine backs it.
//
// Save replaces the whole set (the supervisor holds the authoritative in-memory
// map and writes it out on each change) — matching JSONStore's semantics. Every
// row carries tenant_id so sessions are tenant-scoped and survive a restart.
type PostgresStore struct {
	db *sql.DB
}

// OpenPostgresStore opens (and migrates) the registry at dsn, e.g.
// postgres://ao:ao@localhost:5432/ao_controlplane?sslmode=disable (local) or the
// Azure managed-Postgres connection string (sslmode=require) in production.
func OpenPostgresStore(dsn string) (*PostgresStore, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("controlplane: open registry db: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("controlplane: connect registry db: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("controlplane: migrate registry db: %w", err)
	}
	return &PostgresStore{db: db}, nil
}

// Close closes the underlying database connection.
func (s *PostgresStore) Close() error { return s.db.Close() }

// schemaSQL is applied idempotently on every boot (no migration framework). New
// columns on existing tables use ALTER ... ADD COLUMN IF NOT EXISTS so a
// already-deployed database picks them up without a manual migration.
const schemaSQL = `
CREATE TABLE IF NOT EXISTS cloud_sessions (
	sandbox_id       TEXT PRIMARY KEY,
	tenant_id        TEXT NOT NULL DEFAULT '',
	session_id       TEXT NOT NULL DEFAULT '',
	local_project_id TEXT NOT NULL DEFAULT '',
	project_id       TEXT NOT NULL DEFAULT '',
	harness          TEXT NOT NULL DEFAULT '',
	preview_url      TEXT NOT NULL DEFAULT '',
	status           TEXT NOT NULL DEFAULT '',
	error            TEXT NOT NULL DEFAULT '',
	display_name     TEXT NOT NULL DEFAULT '',
	created_by_user_id TEXT NOT NULL DEFAULT ''
);
ALTER TABLE cloud_sessions ADD COLUMN IF NOT EXISTS created_by_user_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_cloud_sessions_tenant ON cloud_sessions(tenant_id);

-- Humans who authenticate to the control plane. Extensible: metadata (JSONB) and
-- future user-scoped tables key on user_id; cloud_sessions.created_by_user_id
-- already links a sandbox back to its creator.
CREATE TABLE IF NOT EXISTS users (
	user_id    TEXT PRIMARY KEY,
	tenant_id  TEXT NOT NULL DEFAULT '',
	email      TEXT NOT NULL DEFAULT '',
	name       TEXT NOT NULL DEFAULT '',
	metadata   JSONB NOT NULL DEFAULT '{}',
	first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
`

// Load returns all persisted cloud sessions.
func (s *PostgresStore) Load() ([]cloud.CloudSession, error) {
	rows, err := s.db.Query(`SELECT sandbox_id, tenant_id, session_id, local_project_id, project_id,
		harness, preview_url, status, error, display_name, created_by_user_id FROM cloud_sessions`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []cloud.CloudSession
	for rows.Next() {
		var c cloud.CloudSession
		if err := rows.Scan(&c.SandboxID, &c.TenantID, &c.SessionID, &c.LocalProjectID, &c.ProjectID,
			&c.Harness, &c.PreviewURL, &c.Status, &c.Error, &c.DisplayName, &c.CreatedByUserID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Save replaces the entire persisted set of cloud sessions.
func (s *PostgresStore) Save(sessions []cloud.CloudSession) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if _, err := tx.Exec(`DELETE FROM cloud_sessions`); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO cloud_sessions
		(sandbox_id, tenant_id, session_id, local_project_id, project_id, harness, preview_url, status, error, display_name, created_by_user_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, c := range sessions {
		if _, err := stmt.Exec(c.SandboxID, c.TenantID, c.SessionID, c.LocalProjectID, c.ProjectID,
			c.Harness, c.PreviewURL, c.Status, c.Error, c.DisplayName, c.CreatedByUserID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpsertUser records a human sign-in: inserts the user or refreshes tenant +
// last_seen. Implements UserStore. first_seen is preserved on conflict.
func (s *PostgresStore) UpsertUser(ctx context.Context, u User) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users (user_id, tenant_id, email, name, last_seen)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id) DO UPDATE SET
			tenant_id = EXCLUDED.tenant_id,
			email     = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE users.email END,
			name      = CASE WHEN EXCLUDED.name  <> '' THEN EXCLUDED.name  ELSE users.name  END,
			last_seen = now()`,
		u.UserID, u.TenantID, u.Email, u.Name)
	return err
}
