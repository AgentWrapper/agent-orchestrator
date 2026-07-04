package autohand

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAutohandConfigAuthStatusAuthorized(t *testing.T) {
	path := writeAutohandAuthConfig(t, `{
  "auth": {"token": "session-token", "user": {"email": "agent@example.com"}},
  "provider": "zai",
  "zai": {"apiKey": "real-provider-key", "model": "glm-5.1"}
}`)

	got, err := autohandConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAutohandConfigAuthStatusUnauthorizedWithMissingCloudToken(t *testing.T) {
	path := writeAutohandAuthConfig(t, `{
  "auth": {"token": ""},
  "provider": "zai",
  "zai": {"apiKey": "real-provider-key"}
}`)

	got, err := autohandConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnauthorized)
	}
}

func TestAutohandConfigAuthStatusAuthorizedWithPlaceholderProviderKey(t *testing.T) {
	path := writeAutohandAuthConfig(t, `{
  "auth": {"token": "session-token"},
  "provider": "zai",
  "zai": {"apiKey": "api key ", "model": "glm-5.1"}
}`)

	got, err := autohandConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAutohandConfigAuthStatusUnknownWhenMissing(t *testing.T) {
	got, err := autohandConfigAuthStatus(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnknown)
	}
}

func writeAutohandAuthConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
