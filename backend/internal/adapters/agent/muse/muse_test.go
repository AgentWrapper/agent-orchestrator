package muse

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
	if m.ID != "muse" || m.Name != "Muse Code" {
		t.Fatalf("manifest = %#v, want muse/Muse Code", m)
	}
	for _, capability := range m.Capabilities {
		if capability == adapters.CapabilityAgent {
			return
		}
	}
	t.Fatal("manifest missing CapabilityAgent")
}

func TestMuseBinarySpecIncludesUVToolInstallPath(t *testing.T) {
	want := []string{".local", "bin", "muse"}
	for _, path := range museBinarySpec.UnixHomePaths {
		if reflect.DeepEqual(path, want) {
			return
		}
	}
	t.Fatalf("UnixHomePaths = %#v, want %v", museBinarySpec.UnixHomePaths, want)
}

func TestGetConfigSpecAdvertisesModelField(t *testing.T) {
	spec, err := (&Plugin{}).GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 1 || spec.Fields[0].Key != "model" || spec.Fields[0].Type != ports.ConfigFieldString {
		t.Fatalf("fields = %#v, want model/string", spec.Fields)
	}
}

func TestGetLaunchCommandStartsInteractiveSession(t *testing.T) {
	p := &Plugin{resolvedBinary: "muse"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"muse", "--interactive"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandDeliversPromptPositionally(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
	}{
		{name: "ordinary", prompt: "fix the tests"},
		{name: "leading dash", prompt: "-add a health check"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &Plugin{resolvedBinary: "muse"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Prompt: tt.prompt})
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"muse", "--interactive", "--", tt.prompt}
			if !reflect.DeepEqual(cmd, want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, want)
			}
			for _, arg := range cmd {
				if arg == "-p" || arg == "--prompt" {
					t.Fatalf("cmd = %#v unexpectedly uses Muse's single-prompt mode", cmd)
				}
			}
		})
	}
}

func TestGetLaunchCommandAppendsModelBeforePrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "muse"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Config: ports.AgentConfig{Model: "anthropic:claude-sonnet-4"},
		Prompt: "fix it",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"muse", "--interactive", "--model", "anthropic:claude-sonnet-4", "--", "fix it"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandIgnoresPermissionAndSystemPromptArgs(t *testing.T) {
	for _, mode := range []ports.PermissionMode{
		ports.PermissionModeDefault,
		ports.PermissionModeAcceptEdits,
		ports.PermissionModeAuto,
		ports.PermissionModeBypassPermissions,
	} {
		t.Run(string(mode), func(t *testing.T) {
			p := &Plugin{resolvedBinary: "muse"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
				Permissions:  mode,
				SystemPrompt: "AO rules",
			})
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"muse", "--interactive"}
			if !reflect.DeepEqual(cmd, want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, want)
			}
		})
	}
}

func TestGetPromptDeliveryStrategy(t *testing.T) {
	strategy, err := (&Plugin{}).GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if strategy != ports.PromptDeliveryInCommand {
		t.Fatalf("strategy = %q, want %q", strategy, ports.PromptDeliveryInCommand)
	}
}

func TestGetAgentHooksInstallsSystemPromptInstructions(t *testing.T) {
	workspace := t.TempDir()
	if err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{
		WorkspacePath: workspace,
		SystemPrompt:  "follow AO rules\n",
	}); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(museInstructionsPath(workspace))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{museInstructionsSentinel, "# Agent Orchestrator Session Instructions", "follow AO rules", museInstructionsEnd} {
		if !strings.Contains(text, want) {
			t.Fatalf("instructions missing %q:\n%s", want, text)
		}
	}
	gitignore, err := os.ReadFile(filepath.Join(workspace, museInstructionsDirName, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(gitignore), "/AGENTS.md\n") {
		t.Fatalf("gitignore does not ignore AGENTS.md:\n%s", gitignore)
	}
}

func TestGetAgentHooksReadsSystemPromptFile(t *testing.T) {
	workspace := t.TempDir()
	promptFile := filepath.Join(t.TempDir(), "system.md")
	if err := os.WriteFile(promptFile, []byte("file rules\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{
		WorkspacePath:    workspace,
		SystemPromptFile: promptFile,
	}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(museInstructionsPath(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "file rules") {
		t.Fatalf("instructions missing file rules:\n%s", data)
	}
}

func TestGetAgentHooksPreservesAndRewritesUserInstructions(t *testing.T) {
	workspace := t.TempDir()
	path := museInstructionsPath(workspace)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	existing := "before\n\n" + museInstructionFile("old rules") + "\nafter\n"
	if err := os.WriteFile(path, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{
		WorkspacePath: workspace,
		SystemPrompt:  "new rules",
	}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{"before", "after", "new rules"} {
		if !strings.Contains(text, want) {
			t.Fatalf("instructions missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "old rules") || strings.Count(text, museInstructionsSentinel) != 1 {
		t.Fatalf("managed instructions not rewritten cleanly:\n%s", text)
	}
}

func TestGetAgentHooksNoPromptIsNoOp(t *testing.T) {
	workspace := t.TempDir()
	if err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(workspace, museInstructionsDirName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf(".muse stat err = %v, want not exist", err)
	}
}

func TestRestoreAndSessionInfoAreNoOps(t *testing.T) {
	p := &Plugin{}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "session-id"}},
	})
	if err != nil || ok || cmd != nil {
		t.Fatalf("restore = (%#v, %v, %v), want (nil, false, nil)", cmd, ok, err)
	}
	info, ok, err := p.SessionInfo(context.Background(), ports.SessionRef{})
	if err != nil || ok || !reflect.DeepEqual(info, ports.SessionInfo{}) {
		t.Fatalf("session info = (%#v, %v, %v), want zero/false/nil", info, ok, err)
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
	if _, err := ResolveMuseBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ResolveMuseBinary err = %v, want context.Canceled", err)
	}
}
