package amp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAuthStatusAuthorizedFromEnv(t *testing.T) {
	t.Setenv("AMP_API_KEY", "amp-key")

	got, err := (&Plugin{resolvedBinary: "amp"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAmpSettingsAuthStatusAuthorizedWithAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"amp.apiKey":"amp-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := ampSettingsAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestAmpSettingsAuthStatusUnauthorizedWithEmptyAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"amp.apiKey":""}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := ampSettingsAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}

func TestAmpUsageAuthStatusAuthorizedOnSuccessfulUsage(t *testing.T) {
	t.Setenv("AMP_API_KEY", "")
	t.Setenv("AMP_SETTINGS_FILE", filepath.Join(t.TempDir(), "missing-settings.json"))
	restore := mockAuthProbeRunner(t, func(ctx context.Context, name string, arg ...string) ([]byte, error) {
		if name != "amp" || !reflect.DeepEqual(arg, []string{"usage", "--no-color"}) {
			t.Fatalf("command = %s %#v, want amp usage --no-color", name, arg)
		}
		return []byte("Credits remaining: 100"), nil
	})
	defer restore()

	got, err := (&Plugin{resolvedBinary: "amp"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAmpUsageAuthStatusUnauthorizedFromUsageOutput(t *testing.T) {
	t.Setenv("AMP_API_KEY", "")
	t.Setenv("AMP_SETTINGS_FILE", filepath.Join(t.TempDir(), "missing-settings.json"))
	restore := mockAuthProbeRunner(t, func(ctx context.Context, name string, arg ...string) ([]byte, error) {
		return []byte("login required"), errors.New("exit status 1")
	})
	defer restore()

	got, err := (&Plugin{resolvedBinary: "amp"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusUnauthorized)
	}
}

func mockAuthProbeRunner(t *testing.T, runner func(context.Context, string, ...string) ([]byte, error)) func() {
	t.Helper()
	previous := authprobe.CmdRunner
	authprobe.CmdRunner = runner
	return func() { authprobe.CmdRunner = previous }
}
