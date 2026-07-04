package kimi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestKimiLocalAuthStatusAuthorizedWithEnvKey(t *testing.T) {
	t.Setenv("KIMI_API_KEY", "kimi-key")

	status, ok, err := kimiLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestKimiLocalAuthStatusUsesKimiCodeHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(`
[providers.zai-coding-plan]
type = "openai-compatible"
api_key = "secret"
base_url = "https://api.z.ai/api/coding/paas/v4"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := kimiLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestKimiConfigAuthStatusAuthorizedWithProviderAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(`
[providers.zai-coding-plan]
api_key = "secret"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := kimiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestKimiConfigAuthStatusUnauthorizedWithEmptyAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(`
[providers.zai-coding-plan]
api_key = ""
`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := kimiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}
