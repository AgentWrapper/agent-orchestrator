package vibe

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "vibe" {
		t.Fatalf("ID = %q, want vibe", m.ID)
	}
	if m.Name != "Mistral Vibe" {
		t.Fatalf("Name = %q, want Mistral Vibe", m.Name)
	}
	hasAgent := false
	for _, c := range m.Capabilities {
		if c == adapters.CapabilityAgent {
			hasAgent = true
		}
	}
	if !hasAgent {
		t.Fatal("missing CapabilityAgent")
	}
}

func TestGetConfigSpecEmpty(t *testing.T) {
	spec, err := (&Plugin{}).GetConfigSpec(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(spec.Fields) != 0 {
		t.Fatalf("expected no fields, got %d", len(spec.Fields))
	}
}

func TestAuthStatusAuthorizedFromEnv(t *testing.T) {
	clearVibeAuthEnv(t, vibeDefaultAPIKeyEnvVar, "VIBE_CODE_API_KEY")
	t.Setenv(vibeDefaultAPIKeyEnvVar, "test-key")
	p := &Plugin{resolvedBinary: "vibe"}

	got, err := p.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestVibeAPIKeyEnvVarsReadsConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(configPath, []byte("[[providers]]\napi_key_env_var = \"CUSTOM_VIBE_KEY\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := vibeAPIKeyEnvVars(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(got, vibeDefaultAPIKeyEnvVar) || !containsString(got, "CUSTOM_VIBE_KEY") {
		t.Fatalf("vibeAPIKeyEnvVars = %#v, want default and custom key", got)
	}
}

func TestVibeEnvFileAuthStatusAuthorized(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envPath, []byte("MISTRAL_API_KEY=test-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := vibeEnvFileAuthStatus(envPath, vibeDefaultAPIKeyEnvVar)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestVibeEnvFileAuthStatusUnauthorizedForEmptyValue(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envPath, []byte("MISTRAL_API_KEY=\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := vibeEnvFileAuthStatus(envPath, vibeDefaultAPIKeyEnvVar)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusUnauthorized)
	}
}

func TestVibeSessionLogAuthStatusAuthorizedWithAssistantMessage(t *testing.T) {
	dir := t.TempDir()
	sessionDir := filepath.Join(dir, "session_20260625_071829_d5e8a6eb")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "messages.jsonl"), []byte(`{"role":"assistant","content":"Hello"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := vibeSessionLogAuthStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func clearVibeAuthEnv(t *testing.T, names ...string) {
	t.Helper()
	for _, name := range names {
		t.Setenv(name, "")
	}
}

func TestGetPromptDeliveryStrategy(t *testing.T) {
	s, err := (&Plugin{}).GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if s != ports.PromptDeliveryInCommand {
		t.Fatalf("strategy = %q, want %q", s, ports.PromptDeliveryInCommand)
	}
}

func TestGetLaunchCommandWithPrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "add a health check",
		WorkspacePath: "/work/repo",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"vibe", "--trust", "--output", "text", "--workdir", "/work/repo", "--agent", "auto-approve", "-p", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandMapsPermissionModes(t *testing.T) {
	tests := []struct {
		name       string
		mode       ports.PermissionMode
		want       []string
		wantAbsent string
	}{
		{"default omits flag", ports.PermissionModeDefault, []string{"vibe", "--trust", "--output", "text"}, "--agent"},
		{"empty omits flag", "", []string{"vibe", "--trust", "--output", "text"}, "--agent"},
		{"accept edits", ports.PermissionModeAcceptEdits, []string{"vibe", "--trust", "--output", "text", "--agent", "accept-edits"}, ""},
		{"auto", ports.PermissionModeAuto, []string{"vibe", "--trust", "--output", "text", "--agent", "auto-approve"}, ""},
		{"bypass", ports.PermissionModeBypassPermissions, []string{"vibe", "--trust", "--output", "text", "--agent", "auto-approve"}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &Plugin{resolvedBinary: "vibe"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Permissions: tt.mode})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cmd, tt.want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, tt.want)
			}
			if tt.wantAbsent != "" {
				for _, arg := range cmd {
					if arg == tt.wantAbsent {
						t.Fatalf("cmd = %#v unexpectedly contains %q", cmd, tt.wantAbsent)
					}
				}
			}
		})
	}
}

func TestGetLaunchCommandOmitsPromptWhenEmpty(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions: ports.PermissionModeAuto,
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"vibe", "--trust", "--output", "text", "--agent", "auto-approve"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	for _, arg := range cmd {
		if arg == "-p" {
			t.Fatalf("cmd = %#v unexpectedly contains %q", cmd, "-p")
		}
	}
}

func TestGetRestoreCommand(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "abcd1234-5678-90ab-cdef-1234567890ab"},
			WorkspacePath: "/work/repo",
		},
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}

	want := []string{"vibe", "--trust", "--output", "text", "--workdir", "/work/repo", "--agent", "auto-approve", "--resume", "abcd1234-5678-90ab-cdef-1234567890ab"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	_, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{Metadata: map[string]string{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("ok=true with no agentSessionId, want false")
	}
}

func TestGetAgentHooksNoOp(t *testing.T) {
	if err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: t.TempDir()}); err != nil {
		t.Fatalf("GetAgentHooks err = %v, want nil", err)
	}
}

func TestSessionInfoNoOp(t *testing.T) {
	info, ok, err := (&Plugin{}).SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "abcd1234"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("ok=true with info %#v, want no-op false", info)
	}
	if !reflect.DeepEqual(info, ports.SessionInfo{}) {
		t.Fatalf("info = %#v, want zero", info)
	}
}

func TestContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := (&Plugin{}).GetConfigSpec(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetConfigSpec err = %v, want context.Canceled", err)
	}
	if _, err := (&Plugin{}).GetPromptDeliveryStrategy(ctx, ports.LaunchConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetPromptDeliveryStrategy err = %v, want context.Canceled", err)
	}
	if err := (&Plugin{}).GetAgentHooks(ctx, ports.WorkspaceHookConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetAgentHooks err = %v, want context.Canceled", err)
	}
	if _, _, err := (&Plugin{}).GetRestoreCommand(ctx, ports.RestoreConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetRestoreCommand err = %v, want context.Canceled", err)
	}
	if _, _, err := (&Plugin{}).SessionInfo(ctx, ports.SessionRef{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("SessionInfo err = %v, want context.Canceled", err)
	}
}

func TestResolveVibeBinaryContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := ResolveVibeBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ResolveVibeBinary err = %v, want context.Canceled", err)
	}
}
