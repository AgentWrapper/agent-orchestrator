package muse

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestMuseLocalAuthStatusAuthorizedWithProviderEnv(t *testing.T) {
	clearMuseAuthEnv(t)
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	status, ok, err := museLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestMuseLocalAuthStatusUsesXDGConfig(t *testing.T) {
	clearMuseAuthEnv(t)
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	dir := filepath.Join(root, "muse")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "muse.cfg"), []byte("[muse]\nopenai_api_key = sk-config\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := museLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestMuseConfigAuthStatusFindsAnyConfiguredProvider(t *testing.T) {
	path := filepath.Join(t.TempDir(), "muse.cfg")
	if err := os.WriteFile(path, []byte("[muse]\nopenai_api_key = \nanthropic_api_key = 'configured' # comment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, ok, err := museConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestMuseConfigAuthStatusUnknownWithoutCredential(t *testing.T) {
	path := filepath.Join(t.TempDir(), "muse.cfg")
	if err := os.WriteFile(path, []byte("[muse]\nagent_name = muse\nowner_name = user\nopenai_api_key = \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, ok, err := museConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}

func TestMuseLocalAuthStatusUnknownWhenMissing(t *testing.T) {
	clearMuseAuthEnv(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	status, ok, err := museLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}

func TestAuthStatusUsesLocalCredentialProbe(t *testing.T) {
	clearMuseAuthEnv(t)
	t.Setenv("OPENROUTER_API_KEY", "configured")
	status, err := (&Plugin{resolvedBinary: "muse"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusAuthorized)
	}
}

func TestMuseLocalAuthStatusHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	status, ok, err := museLocalAuthStatus(ctx)
	if !errors.Is(err, context.Canceled) || ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v, %v), want (unknown, false, context.Canceled)", status, ok, err)
	}
}

func clearMuseAuthEnv(t *testing.T) {
	t.Helper()
	for _, name := range museAPIKeyEnvVars {
		t.Setenv(name, "")
	}
}
