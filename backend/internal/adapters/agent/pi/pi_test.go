package pi

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "pi" {
		t.Fatalf("ID = %q, want pi", m.ID)
	}
	if m.Name != "Pi" {
		t.Fatalf("Name = %q, want Pi", m.Name)
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

func TestGetLaunchCommandWorkerWithPromptIsInteractive(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Kind:   domain.KindWorker,
		Prompt: "add a health check",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"pi", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandOrchestratorAppendsSystemPromptInteractively(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Kind:         domain.KindOrchestrator,
		SystemPrompt: "coordinate work and avoid implementation",
		Prompt:       "plan the issue",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"pi", "--append-system-prompt", "coordinate work and avoid implementation", "plan the issue"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandEmitsNoPermissionFlag(t *testing.T) {
	// Pi has no permission CLI surface; every mode must produce the same argv
	// and never emit a permission flag.
	modes := []ports.PermissionMode{
		ports.PermissionModeDefault,
		"",
		ports.PermissionModeAcceptEdits,
		ports.PermissionModeAuto,
		ports.PermissionModeBypassPermissions,
	}

	for _, mode := range modes {
		t.Run(string(mode), func(t *testing.T) {
			p := &Plugin{resolvedBinary: "pi"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Permissions: mode})
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"pi"}
			if !reflect.DeepEqual(cmd, want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, want)
			}
			for _, arg := range cmd {
				if arg == "--permission-mode" {
					t.Fatalf("cmd = %#v unexpectedly contains a permission flag", cmd)
				}
			}
		})
	}
}

func TestGetLaunchCommandAppendsSystemPrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPrompt: "follow repo rules",
		Prompt:       "do the thing",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"pi", "--append-system-prompt", "follow repo rules", "do the thing"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandPrefersInlineSystemPrompt(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "system.md")
	if err := os.WriteFile(file, []byte("file contents win"), 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{resolvedBinary: "pi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: file,
		SystemPrompt:     "inline wins",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"pi", "--append-system-prompt", "inline wins"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandSystemPromptFileReadError(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
	_, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: filepath.Join(t.TempDir(), "missing.md"),
	})
	if err == nil {
		t.Fatal("expected error for unreadable system-prompt file, got nil")
	}
}

func TestGetRestoreCommand(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
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

	want := []string{"pi", "--append-system-prompt", "restore inline wins", "--session", "019e950e-52e0-7411-961b-d380ca7e610f"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandReappendsSystemPromptInteractively(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Kind:         domain.KindOrchestrator,
		Session:      ports.SessionRef{Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "019e950e-52e0-7411-961b-d380ca7e610f"}},
		SystemPrompt: "coordinate work and avoid implementation",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}

	want := []string{"pi", "--append-system-prompt", "coordinate work and avoid implementation", "--session", "019e950e-52e0-7411-961b-d380ca7e610f"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	p := &Plugin{resolvedBinary: "pi"}
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

func TestGetAgentHooksInstallsActivityExtension(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "pi"}
	workspace := t.TempDir()
	ctx := context.Background()
	cfg := ports.WorkspaceHookConfig{DataDir: t.TempDir(), SessionID: "sess-1", WorkspacePath: workspace}

	if err := plugin.GetAgentHooks(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(piExtensionPath(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if err := plugin.GetAgentHooks(ctx, cfg); err != nil {
		t.Fatalf("second GetAgentHooks err = %v", err)
	}
	second, err := os.ReadFile(piExtensionPath(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("extension changed across idempotent install")
	}

	body := string(second)
	if !strings.Contains(body, piExtensionSentinel) {
		t.Fatalf("installed extension missing AO sentinel:\n%s", body)
	}
	for _, event := range piManagedEvents {
		want := piHookCommandPrefix + event
		if !strings.Contains(body, want) {
			t.Fatalf("installed extension missing hook command %q:\n%s", want, body)
		}
	}
	for _, marker := range []string{"session_start", "before_agent_start", "agent_settled", "session_shutdown", "getSessionId"} {
		if !strings.Contains(body, marker) {
			t.Fatalf("installed extension missing Pi marker %q:\n%s", marker, body)
		}
	}
	if strings.Contains(body, `pi.on("agent_end"`) {
		t.Fatalf("extension must wait for agent_settled before reporting stop:\n%s", body)
	}
	if !strings.Contains(body, `event?.reason !== "quit"`) {
		t.Fatalf("extension must not report session-end for non-terminal shutdown reasons:\n%s", body)
	}

	gitignore, err := os.ReadFile(filepath.Join(workspace, ".pi", ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(gitignore), "/extensions/ao-activity.ts") {
		t.Fatalf(".pi/.gitignore missing managed extension:\n%s", gitignore)
	}
}

func TestGetAgentHooksRefusesToClobberForeignFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "pi"}
	workspace := t.TempDir()
	extensionPath := piExtensionPath(workspace)
	if err := os.MkdirAll(filepath.Dir(extensionPath), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("export default function notAO() {}\n")
	if err := os.WriteFile(extensionPath, foreign, 0o644); err != nil {
		t.Fatal(err)
	}

	err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace})
	if err == nil {
		t.Fatal("GetAgentHooks overwrote a non-AO file; want a loud error")
	}
	got, readErr := os.ReadFile(extensionPath)
	if readErr != nil {
		t.Fatalf("foreign file removed by refused install: %v", readErr)
	}
	if !reflect.DeepEqual(got, foreign) {
		t.Fatalf("foreign file modified by refused install: %q", got)
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

func TestResolvePiBinaryContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ResolvePiBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ResolvePiBinary err = %v, want context.Canceled", err)
	}
}
