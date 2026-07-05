package continueagent

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "continue" {
		t.Fatalf("ID = %q, want continue", m.ID)
	}
	if m.Name != "Continue" {
		t.Fatalf("Name = %q, want Continue", m.Name)
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

func TestDoesNotImplementAuthChecker(t *testing.T) {
	if _, ok := any(&Plugin{}).(ports.AgentAuthChecker); ok {
		t.Fatal("Continue must not implement AgentAuthChecker; catalog refresh must not run model-call auth probes")
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

func TestGetLaunchCommandBypass(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:      "do the thing",
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"cn", "--print", "--auto", "--", "do the thing"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandAuto(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:      "refactor auth",
		Permissions: ports.PermissionModeAuto,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"cn", "--print", "--auto", "--", "refactor auth"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandDefaultPerms(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt: "fix it",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"cn", "--print", "--", "fix it"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	joined := strings.Join(cmd, " ")
	if strings.Contains(joined, "--auto") || strings.Contains(joined, "--readonly") {
		t.Fatal("should not emit a permission flag for default perms")
	}
}

func TestGetLaunchCommandAcceptEditsNoFlag(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:      "tidy up",
		Permissions: ports.PermissionModeAcceptEdits,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"cn", "--print", "--", "tidy up"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v (accept-edits should emit no flag)", cmd, want)
	}
}

func TestGetLaunchCommandNoPrompt(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"cn", "--print"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Force binary resolution (unset cache) so ctx.Err() is hit.
	_, err := (&Plugin{}).GetLaunchCommand(ctx, ports.LaunchConfig{Prompt: "x"})
	if err == nil {
		t.Fatal("expected error from canceled context, got nil")
	}
}

func TestGetRestoreCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{
				ports.MetadataKeyAgentSessionID: "sess-abc123",
			},
		},
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	want := []string{"cn", "--print", "--auto", "--fork", "sess-abc123"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandDefaultPerms(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{
				ports.MetadataKeyAgentSessionID: "sess-xyz",
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	want := []string{"cn", "--print", "--fork", "sess-xyz"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
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

func TestGetRestoreCommandWhitespaceID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	_, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "   ",
		}},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("ok=true with whitespace agentSessionId, want false")
	}
}

func TestSessionInfoReadsHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "cn-ses-1",
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
	if info.AgentSessionID != "cn-ses-1" {
		t.Fatalf("AgentSessionID = %q, want cn-ses-1", info.AgentSessionID)
	}
	if info.Title != "Fix login redirect" {
		t.Fatalf("Title = %q", info.Title)
	}
	if info.Summary != "Updated the auth callback and tests." {
		t.Fatalf("Summary = %q", info.Summary)
	}
}

func TestSessionInfoFalseWhenNoHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cn"}
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

func TestGetAgentHooksDelegates(t *testing.T) {
	// We don't exercise the full hook merge here (claude tests cover it); just
	// ensure delegation is wired and succeeds against a temp workspace.
	plugin := &Plugin{resolvedBinary: "cn"}
	ws := t.TempDir()
	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{
		WorkspacePath: ws,
		SessionID:     "continue-test-1",
	}); err != nil {
		t.Fatalf("GetAgentHooks: %v", err)
	}
}

func TestResolveContinueBinaryContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ResolveContinueBinary(ctx); err == nil {
		t.Fatal("expected error from canceled context, got nil")
	}
}
