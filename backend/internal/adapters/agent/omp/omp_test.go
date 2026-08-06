package omp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "omp" {
		t.Fatalf("ID = %q, want omp", m.ID)
	}
	if m.Name != "Oh My Pi" {
		t.Fatalf("Name = %q, want Oh My Pi", m.Name)
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

func TestGetConfigSpecReportsModelField(t *testing.T) {
	spec, err := (&Plugin{}).GetConfigSpec(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []ports.ConfigField{
		{
			Key:         "model",
			Type:        ports.ConfigFieldString,
			Description: "Model override passed to `omp --model` (fuzzy match, e.g. \"opus\" or \"gpt-5.2\").",
		},
	}
	if !reflect.DeepEqual(spec.Fields, want) {
		t.Fatalf("config fields\nwant: %#v\n got: %#v", want, spec.Fields)
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

func TestGetLaunchCommandWorkerWithPromptDefaultsToYolo(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Kind:   domain.KindWorker,
		Prompt: "add a health check",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"omp", "--approval-mode", "yolo", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandAppendsConfiguredModelBeforePrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Config:       ports.AgentConfig{Model: "  openai/gpt-5.2  "},
		SystemPrompt: "follow repo rules",
		Prompt:       "add a health check",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"omp",
		"--append-system-prompt", "follow repo rules",
		"--model", "openai/gpt-5.2",
		"--approval-mode", "yolo",
		"add a health check",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandOmitsBlankConfiguredModel(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Config: ports.AgentConfig{Model: " \t "},
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"omp", "--approval-mode", "yolo"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandApprovalModeMapping(t *testing.T) {
	cases := []struct {
		mode ports.PermissionMode
		want []string
	}{
		{ports.PermissionModeDefault, []string{"omp", "--approval-mode", "yolo"}},
		{"", []string{"omp", "--approval-mode", "yolo"}},
		{ports.PermissionModeAuto, []string{"omp", "--approval-mode", "yolo"}},
		{ports.PermissionModeAcceptEdits, []string{"omp", "--approval-mode", "write"}},
		{ports.PermissionModeBypassPermissions, []string{"omp", "--auto-approve"}},
	}
	for _, tc := range cases {
		t.Run(string(tc.mode), func(t *testing.T) {
			p := &Plugin{resolvedBinary: "omp"}
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

func TestGetLaunchCommandPrefersInlineSystemPrompt(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "system.md")
	if err := os.WriteFile(file, []byte("file contents win"), 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: file,
		SystemPrompt:     "inline wins",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"omp", "--append-system-prompt", "inline wins", "--approval-mode", "yolo"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandReadsSystemPromptFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "system.md")
	if err := os.WriteFile(file, []byte("file contents"), 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: file,
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"omp", "--append-system-prompt", "file contents", "--approval-mode", "yolo"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandSystemPromptFileReadError(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	_, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: filepath.Join(t.TempDir(), "missing.md"),
	})
	if err == nil {
		t.Fatal("expected error for unreadable system-prompt file, got nil")
	}
}

func TestGetRestoreCommand(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		SystemPrompt:     "restore inline wins",
		SystemPromptFile: filepath.Join(t.TempDir(), "missing.md"),
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "019e950e-52e0-7411-961b-d380ca7e610f"},
		},
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}

	want := []string{
		"omp",
		"--append-system-prompt", "restore inline wins",
		"--auto-approve",
		"--resume", "019e950e-52e0-7411-961b-d380ca7e610f",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandAppendsConfiguredModelBeforeSession(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Config: ports.AgentConfig{Model: "opus"},
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

	want := []string{"omp", "--model", "opus", "--approval-mode", "yolo", "--resume", "019e950e-52e0-7411-961b-d380ca7e610f"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
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
		Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "019e950e-52e0-7411-961b-d380ca7e610f"},
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

func TestResolveOMPBinaryContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ResolveOMPBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ResolveOMPBinary err = %v, want context.Canceled", err)
	}
}
