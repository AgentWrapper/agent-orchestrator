package omp

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestOMPDBAuthStatusAuthorizedWithEnabledCredential(t *testing.T) {
	dbPath := writeAuthCredentialsDB(t, []authCredentialRow{
		{provider: "anthropic", disabledCause: ""},
	})
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Dir(dbPath))

	status, ok, err := ompDBAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestOMPDBAuthStatusUnauthorizedWhenAllDisabled(t *testing.T) {
	dbPath := writeAuthCredentialsDB(t, []authCredentialRow{
		{provider: "anthropic", disabledCause: "revoked"},
	})
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Dir(dbPath))

	status, ok, err := ompDBAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}

func TestOMPDBAuthStatusUnauthorizedWhenEmpty(t *testing.T) {
	dbPath := writeAuthCredentialsDB(t, nil)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Dir(dbPath))

	status, ok, err := ompDBAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}

func TestOMPDBAuthStatusUnknownWhenMissing(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_DIR", t.TempDir())

	status, ok, err := ompDBAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}

func TestOMPDBAuthStatusUnknownWhenSchemaUnrecognized(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "agent.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE some_other_table (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_CODING_AGENT_DIR", dir)

	status, ok, err := ompDBAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false) on schema mismatch", status, ok, ports.AgentAuthStatusUnknown)
	}
}

func TestAuthStatusEnvVarFastPath(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_DIR", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")

	p := &Plugin{resolvedBinary: "omp"}
	status, err := p.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusAuthorized)
	}
}

type authCredentialRow struct {
	provider      string
	disabledCause string
}

// writeAuthCredentialsDB creates an agent.db-shaped sqlite file matching the
// real OMP auth_credentials schema and returns its path.
func writeAuthCredentialsDB(t *testing.T, rows []authCredentialRow) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "agent.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = db.Close()
	}()

	if _, err := db.Exec(`
		CREATE TABLE auth_credentials (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL,
			credential_type TEXT NOT NULL,
			data TEXT NOT NULL,
			disabled_cause TEXT DEFAULT NULL,
			identity_key TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		)
	`); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		var disabledCause any
		if row.disabledCause != "" {
			disabledCause = row.disabledCause
		}
		if _, err := db.Exec(
			`INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)`,
			row.provider, "api_key", `{"key":"test"}`, disabledCause,
		); err != nil {
			t.Fatal(err)
		}
	}
	return dbPath
}
