package pi

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPiAuthJSONStatusAuthorizedWithProviderKey(t *testing.T) {
	path := writePiAuthJSON(t, `{"zai":{"type":"api_key","key":"test-key"}}`)

	status, ok, err := piAuthJSONStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestPiAuthJSONStatusUnauthorizedWhenEmpty(t *testing.T) {
	path := writePiAuthJSON(t, `{}`)

	status, ok, err := piAuthJSONStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}

func writePiAuthJSON(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
