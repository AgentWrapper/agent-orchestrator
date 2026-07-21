package vibe

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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

	want := []string{"vibe", "--trust", "--workdir", "/work/repo", "--agent", "auto-approve", "--", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandBuildsCustomAgentForSystemPrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	promptFile := filepath.Join(t.TempDir(), "system.md")
	workspace := t.TempDir()
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:      ports.PermissionModeAuto,
		Prompt:           "add a health check",
		SystemPrompt:     "follow AO rules",
		SystemPromptFile: promptFile,
		WorkspacePath:    workspace,
	})
	if err != nil {
		t.Fatal(err)
	}

	addDir := filepath.Join(filepath.Dir(promptFile), "vibe")
	want := []string{"vibe", "--trust", "--workdir", workspace, "--add-dir", addDir, "--agent", "ao-system-prompt", "--auto-approve", "--", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
	promptData, err := os.ReadFile(filepath.Join(addDir, ".vibe", "prompts", "ao-system-prompt.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(promptData) != "follow AO rules\n" {
		t.Fatalf("prompt file = %q, want inline rules", promptData)
	}
	agentData, err := os.ReadFile(filepath.Join(addDir, ".vibe", "agents", "ao-system-prompt.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(agentData), `system_prompt_id = "ao-system-prompt"`) {
		t.Fatalf("agent config missing prompt id:\n%s", agentData)
	}
}

func TestGetLaunchCommandCustomAgentAcceptEdits(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	promptFile := filepath.Join(t.TempDir(), "system.md")
	workspace := t.TempDir()
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:      ports.PermissionModeAcceptEdits,
		SystemPrompt:     "follow AO rules",
		SystemPromptFile: promptFile,
		WorkspacePath:    workspace,
	})
	if err != nil {
		t.Fatal(err)
	}

	addDir := filepath.Join(filepath.Dir(promptFile), "vibe")
	want := []string{"vibe", "--trust", "--workdir", workspace, "--add-dir", addDir, "--agent", "ao-system-prompt"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
	agentData, err := os.ReadFile(filepath.Join(addDir, ".vibe", "agents", "ao-system-prompt.toml"))
	if err != nil {
		t.Fatal(err)
	}
	body := string(agentData)
	for _, wantText := range []string{`[tools.write_file]`, `[tools.search_replace]`, `permission = "always"`} {
		if !strings.Contains(body, wantText) {
			t.Fatalf("agent config missing %q:\n%s", wantText, body)
		}
	}
}

func TestGetLaunchCommandMapsPermissionModes(t *testing.T) {
	tests := []struct {
		name       string
		mode       ports.PermissionMode
		want       []string
		wantAbsent string
	}{
		{"default omits flag", ports.PermissionModeDefault, []string{"vibe", "--trust", "--", "task"}, "--agent"},
		{"empty omits flag", "", []string{"vibe", "--trust", "--", "task"}, "--agent"},
		{"accept edits", ports.PermissionModeAcceptEdits, []string{"vibe", "--trust", "--agent", "accept-edits", "--", "task"}, ""},
		{"auto", ports.PermissionModeAuto, []string{"vibe", "--trust", "--agent", "auto-approve", "--", "task"}, ""},
		{"bypass", ports.PermissionModeBypassPermissions, []string{"vibe", "--trust", "--agent", "auto-approve", "--", "task"}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &Plugin{resolvedBinary: "vibe"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Permissions: tt.mode, Prompt: "task"})
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

func TestGetLaunchCommandPromptlessLaunchStaysInteractive(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeAuto,
		WorkspacePath: "/work/repo",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"vibe", "--trust", "--workdir", "/work/repo", "--agent", "auto-approve"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandWhitespacePromptStaysInteractive(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:      " \t\n",
		Permissions: ports.PermissionModeAcceptEdits,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"vibe", "--trust", "--agent", "accept-edits"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
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

	want := []string{"vibe", "--trust", "--workdir", "/work/repo", "--agent", "auto-approve", "--resume", "abcd1234-5678-90ab-cdef-1234567890ab"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandReappliesSystemPromptAgent(t *testing.T) {
	p := &Plugin{resolvedBinary: "vibe"}
	promptFile := filepath.Join(t.TempDir(), "system.md")
	workspace := t.TempDir()
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions:      ports.PermissionModeAuto,
		SystemPrompt:     "restore AO rules",
		SystemPromptFile: promptFile,
		Session: ports.SessionRef{
			WorkspacePath: workspace,
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "abcd1234"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}

	addDir := filepath.Join(filepath.Dir(promptFile), "vibe")
	want := []string{"vibe", "--trust", "--workdir", workspace, "--add-dir", addDir, "--agent", "ao-system-prompt", "--auto-approve", "--resume", "abcd1234"}
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

func TestGetAgentHooksInstallsManagedHooksWithoutChangingConfig(t *testing.T) {
	workspace := t.TempDir()
	dir := filepath.Join(workspace, ".vibe")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	userHooks := "[[hooks]]\nname = \"user-hook\"\ntype = \"post_agent\"\ncommand = \"user-command\"\n"
	if err := os.WriteFile(filepath.Join(dir, "hooks.toml"), []byte(userHooks), 0o600); err != nil {
		t.Fatal(err)
	}
	userConfig := "log_interactions = false\nactive_model = \"custom-model\"\n"
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(userConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{}
	for range 2 {
		if err := p.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
			t.Fatalf("GetAgentHooks: %v", err)
		}
	}

	hooks, err := os.ReadFile(filepath.Join(dir, "hooks.toml"))
	if err != nil {
		t.Fatal(err)
	}
	body := string(hooks)
	for _, want := range []string{
		"user-command",
		`name = "ao-session-metadata"`,
		`type = "post_agent"`,
		`name = "ao-pre-tool"`,
		`type = "pre_tool"`,
		`name = "ao-post-tool"`,
		`type = "post_tool"`,
		`match = "*"`,
		`command = "ao hooks vibe post-agent"`,
		`command = "ao hooks vibe pre-tool"`,
		`command = "ao hooks vibe post-tool"`,
		"timeout = 30.0",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("hooks.toml missing %q:\n%s", want, body)
		}
	}
	if strings.Count(body, vibeHooksSentinelStart) != 1 || strings.Count(body, "ao hooks vibe post-agent") != 1 {
		t.Fatalf("managed hooks duplicated:\n%s", body)
	}
	if strings.Count(body, "timeout = 30.0") != 3 || strings.Count(body, `match = "*"`) != 2 {
		t.Fatalf("unexpected Vibe hook schema:\n%s", body)
	}

	config, err := os.ReadFile(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(config); got != userConfig {
		t.Fatalf("config.toml changed\nwant: %q\n got: %q", userConfig, got)
	}
	ignore, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"/hooks.toml\n"} {
		if !strings.Contains(string(ignore), want) {
			t.Fatalf(".gitignore missing %q:\n%s", want, ignore)
		}
	}
	if strings.Contains(string(ignore), "/config.toml\n") {
		t.Fatalf(".gitignore unexpectedly claims user config:\n%s", ignore)
	}
}

func TestGetAgentHooksRequiresWorkspace(t *testing.T) {
	err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{})
	if err == nil || !strings.Contains(err.Error(), "WorkspacePath is required") {
		t.Fatalf("GetAgentHooks error = %v", err)
	}
}

func TestUninstallHooksPreservesUserHooks(t *testing.T) {
	workspace := t.TempDir()
	p := &Plugin{}
	if err := p.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
		t.Fatal(err)
	}
	installed, err := p.AreHooksInstalled(context.Background(), workspace)
	if err != nil || !installed {
		t.Fatalf("AreHooksInstalled = (%v, %v), want (true, nil)", installed, err)
	}
	path := filepath.Join(workspace, ".vibe", "hooks.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	withUserHook := "[[hooks]]\nname = \"user-hook\"\ntype = \"post_agent\"\ncommand = \"user-command\"\n\n" + string(data)
	if err := os.WriteFile(path, []byte(withUserHook), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := p.UninstallHooks(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	installed, err = p.AreHooksInstalled(context.Background(), workspace)
	if err != nil || installed {
		t.Fatalf("AreHooksInstalled after uninstall = (%v, %v), want (false, nil)", installed, err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "user-command") || strings.Contains(string(got), "ao hooks vibe") {
		t.Fatalf("hooks after uninstall:\n%s", got)
	}
}

func TestSessionInfoReadsHookMetadata(t *testing.T) {
	info, ok, err := (&Plugin{}).SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "abcd1234"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want hook metadata")
	}
	if info.AgentSessionID != "abcd1234" {
		t.Fatalf("AgentSessionID = %q", info.AgentSessionID)
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
