package kimchi

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
	if m.ID != "kimchi" {
		t.Fatalf("ID = %q, want kimchi", m.ID)
	}
	if m.Name != "Kimchi" {
		t.Fatalf("Name = %q, want Kimchi", m.Name)
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
	p := &Plugin{resolvedBinary: "kimchi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt: "add a health check",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"kimchi", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandPermissions(t *testing.T) {
	tests := []struct {
		mode ports.PermissionMode
		want []string
	}{
		{ports.PermissionModeDefault, []string{"kimchi"}},
		{"", []string{"kimchi"}},
		{ports.PermissionModeAcceptEdits, []string{"kimchi", "--auto"}},
		{ports.PermissionModeAuto, []string{"kimchi", "--auto"}},
		{ports.PermissionModeBypassPermissions, []string{"kimchi", "--yolo"}},
	}

	for _, tc := range tests {
		t.Run(string(tc.mode), func(t *testing.T) {
			p := &Plugin{resolvedBinary: "kimchi"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Permissions: tc.mode})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cmd, tc.want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, tc.want)
			}
		})
	}
}

func TestGetLaunchCommandAppendsSystemPrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "kimchi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPrompt: "follow repo rules",
		Prompt:       "do the thing",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"kimchi", "--append-system-prompt", "follow repo rules", "do the thing"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandInlinesSystemPromptFileContents(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "system.md")
	if err := os.WriteFile(file, []byte("file contents win"), 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{resolvedBinary: "kimchi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: file,
		SystemPrompt:     "inline ignored",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"kimchi", "--append-system-prompt", "file contents win"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandSystemPromptFileReadError(t *testing.T) {
	p := &Plugin{resolvedBinary: "kimchi"}
	_, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: filepath.Join(t.TempDir(), "missing.md"),
		SystemPrompt:     "inline ignored",
	})
	if err == nil {
		t.Fatal("expected error for unreadable system-prompt file, got nil")
	}
}

func TestGetRestoreCommand(t *testing.T) {
	p := &Plugin{resolvedBinary: "kimchi"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "019e950e-52e0-7411-961b-d380ca7e610f"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}

	want := []string{"kimchi", "--session", "019e950e-52e0-7411-961b-d380ca7e610f"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	p := &Plugin{resolvedBinary: "kimchi"}
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

func TestSessionInfoWithMetadata(t *testing.T) {
	info, ok, err := (&Plugin{}).SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "019e950e-52e0-7411-961b-d380ca7e610f",
			ports.MetadataKeyTitle:          "add health check",
			ports.MetadataKeySummary:        "added /health endpoint",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if info.AgentSessionID != "019e950e-52e0-7411-961b-d380ca7e610f" {
		t.Fatalf("AgentSessionID = %q", info.AgentSessionID)
	}
	if info.Title != "add health check" {
		t.Fatalf("Title = %q", info.Title)
	}
	if info.Summary != "added /health endpoint" {
		t.Fatalf("Summary = %q", info.Summary)
	}
}

func TestSessionInfoNoMetadata(t *testing.T) {
	_, ok, err := (&Plugin{}).SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("ok=true with no metadata, want false")
	}
}

func TestGetAgentHooksWritesSettingsFile(t *testing.T) {
	workspace := t.TempDir()
	p := &Plugin{}
	if err := p.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{
		WorkspacePath: workspace,
	}); err != nil {
		t.Fatal(err)
	}

	settingsFile := filepath.Join(workspace, ".kimchi", "hooks.local.json")
	data, err := os.ReadFile(settingsFile)
	if err != nil {
		t.Fatalf("settings file not created: %v", err)
	}

	content := string(data)
	for _, cmd := range []string{
		"ao hooks kimchi session-start",
		"ao hooks kimchi user-prompt-submit",
		"ao hooks kimchi stop",
		"ao hooks kimchi notification",
		"ao hooks kimchi session-end",
	} {
		if !contains(content, cmd) {
			t.Errorf("settings missing hook command %q", cmd)
		}
	}

	gitignore := filepath.Join(workspace, ".kimchi", ".gitignore")
	if _, err := os.Stat(gitignore); err != nil {
		t.Fatalf("gitignore not created: %v", err)
	}
}

func TestGetAgentHooksIdempotent(t *testing.T) {
	workspace := t.TempDir()
	p := &Plugin{}
	cfg := ports.WorkspaceHookConfig{WorkspacePath: workspace}

	if err := p.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if err := p.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}

	settingsFile := filepath.Join(workspace, ".kimchi", "hooks.local.json")
	data, err := os.ReadFile(settingsFile)
	if err != nil {
		t.Fatal(err)
	}

	content := string(data)
	count := countOccurrences(content, "ao hooks kimchi session-start")
	if count != 1 {
		t.Fatalf("session-start hook duplicated: found %d occurrences", count)
	}
}

func TestUninstallHooks(t *testing.T) {
	workspace := t.TempDir()
	p := &Plugin{}
	cfg := ports.WorkspaceHookConfig{WorkspacePath: workspace}

	if err := p.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if err := p.UninstallHooks(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}

	settingsFile := filepath.Join(workspace, ".kimchi", "hooks.local.json")
	data, err := os.ReadFile(settingsFile)
	if err != nil {
		t.Fatal(err)
	}
	if contains(string(data), "ao hooks kimchi") {
		t.Fatal("hooks not removed after uninstall")
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

func TestResolveKimchiBinaryContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ResolveKimchiBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ResolveKimchiBinary err = %v, want context.Canceled", err)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func countOccurrences(s, substr string) int {
	count := 0
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			count++
		}
	}
	return count
}
