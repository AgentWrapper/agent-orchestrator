package kimchi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// clearKimchiAuthEnv unsets KIMCHI_API_KEY so env-var auth state doesn't leak
// between tests.
func clearKimchiAuthEnv(t *testing.T) {
	t.Helper()
	t.Setenv("KIMCHI_API_KEY", "")
}

// withTempHome sets HOME to a temp dir so tests don't read the real
// ~/.config/kimchi/config.json. Returns the temp dir.
func withTempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

// writeKimchiGlobalConfig writes content to ~/.config/kimchi/config.json under
// the temp HOME. Returns the config path.
func writeKimchiGlobalConfig(t *testing.T, home, content string) string {
	t.Helper()
	configPath := filepath.Join(home, ".config", "kimchi", "config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return configPath
}

// ---------------------------------------------------------------------------
// kimchiConfigAuthStatus — pure config-file probe (no binary dependency)
// ---------------------------------------------------------------------------

func TestConfigAuthStatusAuthorizedFromAPIKey(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{"apiKey":"test-key-123"}`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestConfigAuthStatusAuthorizedFromSnakeCase(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{"api_key":"legacy-key-456"}`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestConfigAuthStatusPrefersCamelCase(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{"apiKey":"new-key","api_key":"old-key"}`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestConfigAuthStatusUnauthorizedWhenNoKey(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{"otherField":"value","onboarding":{"done":true}}`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnauthorized)
	}
}

func TestConfigAuthStatusUnauthorizedWhenKeyEmpty(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{"apiKey":""}`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnauthorized)
	}
}

func TestConfigAuthStatusUnknownWhenFileMissing(t *testing.T) {
	home := withTempHome(t)
	missingPath := filepath.Join(home, ".config", "kimchi", "config.json")

	got, err := kimchiConfigAuthStatus(missingPath)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnknown)
	}
}

func TestConfigAuthStatusUnknownWhenMalformed(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{not valid json`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnknown)
	}
}

func TestConfigAuthStatusUnknownWhenPathEmpty(t *testing.T) {
	got, err := kimchiConfigAuthStatus("")
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnknown)
	}
}

func TestConfigAuthStatusIgnoresNonStringKey(t *testing.T) {
	home := withTempHome(t)
	path := writeKimchiGlobalConfig(t, home, `{"apiKey":12345}`)

	got, err := kimchiConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = %q, want %q", got, ports.AgentAuthStatusUnauthorized)
	}
}

// ---------------------------------------------------------------------------
// kimchiExtractAPIKey — unit test for the field extractor
// ---------------------------------------------------------------------------

func TestExtractAPIKey(t *testing.T) {
	tests := []struct {
		name    string
		json    string
		wantKey string
	}{
		{"camelCase", `{"apiKey":"abc"}`, "abc"},
		{"snake_case", `{"api_key":"def"}`, "def"},
		{"both prefers camelCase", `{"apiKey":"new","api_key":"old"}`, "new"},
		{"empty string ignored", `{"apiKey":""}`, ""},
		{"whitespace-only ignored", `{"apiKey":"  "}`, ""},
		{"missing field", `{"other":"x"}`, ""},
		{"non-string value", `{"apiKey":42}`, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var config map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tc.json), &config); err != nil {
				t.Fatal(err)
			}
			got := kimchiExtractAPIKey(config)
			if got != tc.wantKey {
				t.Fatalf("kimchiExtractAPIKey = %q, want %q", got, tc.wantKey)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Plugin.AuthStatus — integration of binary + env + config
// ---------------------------------------------------------------------------

func TestAuthStatusAuthorizedFromEnvVar(t *testing.T) {
	clearKimchiAuthEnv(t)
	withTempHome(t) // ensure no real config file is read
	t.Setenv("KIMCHI_API_KEY", "env-key-789")
	plugin := &Plugin{resolvedBinary: "kimchi"}

	got, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAuthStatusAuthorizedFromConfig(t *testing.T) {
	clearKimchiAuthEnv(t)
	home := withTempHome(t)
	writeKimchiGlobalConfig(t, home, `{"apiKey":"file-key-012"}`)
	plugin := &Plugin{resolvedBinary: "kimchi"}

	got, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAuthStatusUnauthorizedFromConfigWithoutKey(t *testing.T) {
	clearKimchiAuthEnv(t)
	home := withTempHome(t)
	writeKimchiGlobalConfig(t, home, `{"preferences":{"theme":"dark"}}`)
	plugin := &Plugin{resolvedBinary: "kimchi"}

	got, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusUnauthorized)
	}
}

func TestAuthStatusUnknownWhenNoEnvAndNoConfig(t *testing.T) {
	clearKimchiAuthEnv(t)
	withTempHome(t) // no config file under temp home
	plugin := &Plugin{resolvedBinary: "kimchi"}

	got, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusUnknown {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusUnknown)
	}
}

func TestAuthStatusEnvVarPrecedenceOverConfig(t *testing.T) {
	clearKimchiAuthEnv(t)
	home := withTempHome(t)
	writeKimchiGlobalConfig(t, home, `{"apiKey":"config-key"}`)
	t.Setenv("KIMCHI_API_KEY", "env-key")
	plugin := &Plugin{resolvedBinary: "kimchi"}

	got, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAuthStatusContextCanceled(t *testing.T) {
	clearKimchiAuthEnv(t)
	plugin := &Plugin{resolvedBinary: "kimchi"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := plugin.AuthStatus(ctx)
	if err == nil {
		t.Fatal("AuthStatus: expected error from cancelled context, got nil")
	}
}

func TestAuthStatusUnknownWhenBinaryNotFound(t *testing.T) {
	clearKimchiAuthEnv(t)
	withTempHome(t)
	// Plugin with no resolved binary: kimchiBinary calls ResolveKimchiBinary.
	// On machines without kimchi installed (CI), this returns ErrAgentBinaryNotFound
	// → (Unknown, nil). On dev machines where kimchi IS installed, the binary
	// resolves and the test falls through to config — so we accept either Unknown
	// (binary not found) or Unknown (no config file under temp home).
	plugin := &Plugin{}

	got, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatalf("AuthStatus should not return error for missing binary: %v", err)
	}
	if got != ports.AgentAuthStatusUnknown {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusUnknown)
	}
}
