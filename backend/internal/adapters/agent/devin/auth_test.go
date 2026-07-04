package devin

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAuthStatusAuthorizedFromAuthStatusOutput(t *testing.T) {
	previous := authprobe.CmdRunner
	authprobe.CmdRunner = func(ctx context.Context, name string, arg ...string) ([]byte, error) {
		if name != "devin" || !reflect.DeepEqual(arg, []string{"auth", "status"}) {
			t.Fatalf("command = %s %#v, want devin auth status", name, arg)
		}
		return []byte("Logged in (via Devin).\n\nUser:\n  Email: agentsubs@example.com\n"), nil
	}
	defer func() { authprobe.CmdRunner = previous }()

	got, err := (&Plugin{resolvedBinary: "devin"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestDevinCredentialsAuthStatusAuthorized(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.toml")
	if err := os.WriteFile(path, []byte("windsurf_api_key = \"token\"\ndevin_api_url = \"https://api.devin.ai\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := devinCredentialsAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestDevinCredentialsAuthStatusUnauthorizedWithEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.toml")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := devinCredentialsAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}
