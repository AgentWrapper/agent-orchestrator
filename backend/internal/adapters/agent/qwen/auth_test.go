package qwen

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestQwenLocalAuthStatusAuthorizedWithProviderEnv(t *testing.T) {
	t.Setenv("ZAI_API_KEY", "zai-key")

	status, ok, err := qwenLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestQwenAuthStatusFromSettingsAuthorizedWithModelProviderAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	content := `{
		"modelProviders": {
			"zai": {
				"baseUrl": "https://api.z.ai/api/coding/paas/v4",
				"apiKey": "zai-key"
			}
		},
		"defaultModel": "glm-4.5"
	}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := qwenAuthStatusFromSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestQwenAuthStatusFromSettingsAuthorizedWithSecurityAuthAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	content := `{
		"security": {
			"auth": {
				"apiKey": "openai-compatible-key"
			}
		}
	}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := qwenAuthStatusFromSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestQwenAuthStatusFromSettingsUnknownWhenMissing(t *testing.T) {
	status, ok, err := qwenAuthStatusFromSettings(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}
