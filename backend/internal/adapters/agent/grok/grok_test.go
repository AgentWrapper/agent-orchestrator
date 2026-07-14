package grok

import (
	"context"
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
	if m.ID != "grok" {
		t.Fatalf("ID = %q, want grok", m.ID)
	}
	if m.Name != "Grok Build" {
		t.Fatalf("Name = %q", m.Name)
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
		t.Fatalf("strategy = %q, want in_command", s)
	}
}

func TestGetLaunchCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:       "do the thing",
		SystemPrompt: "ao standing instructions",
		Permissions:  ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	wantPrefix := []string{"grok", "--no-auto-update", "--permission-mode", "bypassPermissions", "--rules", "ao standing instructions", "--", "do the thing"}
	if !reflect.DeepEqual(cmd, wantPrefix) {
		t.Fatalf("cmd = %#v, want prefix %#v", cmd, wantPrefix)
	}
	if strings.Contains(strings.Join(cmd, " "), "system-prompt-override") {
		t.Fatalf("cmd = %#v must append rules, not override Grok's system prompt", cmd)
	}
	assertNoPromptFlag(t, cmd)
}

func TestGetLaunchCommandDefaultPerms(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt: "fix it",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"grok", "--no-auto-update", "--", "fix it"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	if strings.Contains(strings.Join(cmd, " "), "permission-mode") {
		t.Fatal("should not have --permission-mode for default perms")
	}
	assertNoPromptFlag(t, cmd)
}

func TestGetLaunchCommandAcceptEdits(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:      "refactor auth",
		Permissions: ports.PermissionModeAcceptEdits,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"grok", "--no-auto-update", "--permission-mode", "acceptEdits", "--", "refactor auth"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	assertNoPromptFlag(t, cmd)
}

func TestGetLaunchCommandTerminatesFlagsBeforeLeadingDashPrompt(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt: "-add a health check",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"grok", "--no-auto-update", "--", "-add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	assertNoPromptFlag(t, cmd)
}

func assertNoPromptFlag(t *testing.T, cmd []string) {
	t.Helper()
	for _, arg := range cmd {
		if arg == "-p" || arg == "--single" {
			t.Fatalf("cmd = %#v unexpectedly contains single-turn prompt flag %q", cmd, arg)
		}
	}
}

func TestGetLaunchCommandSystemPromptFromFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	promptFile := filepath.Join(t.TempDir(), "system.md")
	if err := os.WriteFile(promptFile, []byte("file standing instructions\n\n"), 0o600); err != nil {
		t.Fatalf("write prompt file: %v", err)
	}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:           "fix it",
		SystemPromptFile: promptFile,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"grok", "--no-auto-update", "--rules", "file standing instructions", "--", "fix it"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	assertNoPromptFlag(t, cmd)
}

func TestGetLaunchCommandMissingSystemPromptFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	_, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:           "fix it",
		SystemPromptFile: filepath.Join(t.TempDir(), "missing.md"),
	})
	if err == nil {
		t.Fatal("expected error for missing system prompt file")
	}
	if !strings.Contains(err.Error(), "grok: read system prompt file") {
		t.Fatalf("err = %v, want system prompt file read error", err)
	}
}

func TestGetRestoreCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{
				ports.MetadataKeyAgentSessionID: "sess-abc123",
			},
		},
		SystemPrompt: "ao restore instructions",
		Permissions:  ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	want := []string{"grok", "--no-auto-update", "--permission-mode", "bypassPermissions", "--rules", "ao restore instructions", "-r", "sess-abc123"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	if strings.Contains(strings.Join(cmd, " "), "system-prompt-override") {
		t.Fatalf("cmd = %#v must append rules, not override Grok's system prompt", cmd)
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	_, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{Metadata: map[string]string{}},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("ok=true with no agentSessionId, want false")
	}
}

func TestSessionInfoReadsHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "grok-ses-1",
			ports.MetadataKeyTitle:          "Fix login redirect",
			ports.MetadataKeySummary:        "Updated the auth callback and tests.",
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if info.AgentSessionID != "grok-ses-1" {
		t.Fatalf("AgentSessionID = %q, want grok-ses-1", info.AgentSessionID)
	}
	if info.Title != "Fix login redirect" {
		t.Fatalf("Title = %q", info.Title)
	}
	if info.Summary != "Updated the auth callback and tests." {
		t.Fatalf("Summary = %q", info.Summary)
	}
}

func TestSessionInfoFalseWhenNoHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "grok"}
	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatalf("ok=true with empty metadata, want false")
	}
	if !reflect.DeepEqual(info, ports.SessionInfo{}) {
		t.Fatalf("info = %#v, want zero", info)
	}
}

func TestHookLifecycleDelegates(t *testing.T) {
	// Claude tests cover the full merge behavior; here we assert Grok exposes
	// the same delegated lifecycle so Grok-installed compat hooks can be
	// detected and removed through the Grok adapter.
	plugin := &Plugin{resolvedBinary: "grok"}
	ctx := context.Background()
	ws := t.TempDir()
	cfg := ports.WorkspaceHookConfig{
		WorkspacePath: ws,
		SessionID:     "grok-test-1",
	}

	if err := plugin.GetAgentHooks(ctx, cfg); err != nil {
		t.Fatalf("GetAgentHooks: %v", err)
	}
	if installed, err := plugin.AreHooksInstalled(ctx, ws); err != nil || !installed {
		t.Fatalf("AreHooksInstalled after install = (%v, %v), want (true, nil)", installed, err)
	}
	if err := plugin.UninstallHooks(ctx, ws); err != nil {
		t.Fatalf("UninstallHooks: %v", err)
	}
	if installed, err := plugin.AreHooksInstalled(ctx, ws); err != nil || installed {
		t.Fatalf("AreHooksInstalled after uninstall = (%v, %v), want (false, nil)", installed, err)
	}
}
