package kimi

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "kimi" {
		t.Fatalf("ID = %q, want kimi", m.ID)
	}
	if m.Name != "Kimi" {
		t.Fatalf("Name = %q, want Kimi", m.Name)
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
	if s != ports.PromptDeliveryAfterStart {
		t.Fatalf("strategy = %q, want %q", s, ports.PromptDeliveryAfterStart)
	}
}

func TestPromptReadinessHints(t *testing.T) {
	hints, err := (&Plugin{}).PromptReadinessHints(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if hints.Timeout <= 0 || len(hints.Patterns) == 0 {
		t.Fatalf("hints = %#v, want bounded readiness patterns", hints)
	}
}

// Kimi prompt mode is non-interactive, so AO launches the TUI and lets the
// session manager inject the task after startup. Because the prompt is not
// carried with `-p`, approval flags remain valid for prompted workers.
func TestGetLaunchCommandInteractiveMapsPermissionModes(t *testing.T) {
	tests := []struct {
		name       string
		mode       ports.PermissionMode
		prompt     string
		want       []string
		wantAbsent string
	}{
		{"default omits flag", ports.PermissionModeDefault, "fix it", []string{"kimi"}, "--auto"},
		{"empty omits flag", "", "fix it", []string{"kimi"}, "--auto"},
		{"accept edits", ports.PermissionModeAcceptEdits, "-add a health check", []string{"kimi", "--auto"}, "-y"},
		{"auto", ports.PermissionModeAuto, "fix it", []string{"kimi", "--auto"}, "-y"},
		{"bypass", ports.PermissionModeBypassPermissions, "fix it", []string{"kimi", "-y"}, "--auto"},
		{"promptless interactive", ports.PermissionModeAuto, "", []string{"kimi", "--auto"}, "-p"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &Plugin{resolvedBinary: "kimi"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Permissions: tt.mode, Prompt: tt.prompt})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cmd, tt.want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, tt.want)
			}
			for _, arg := range cmd {
				if arg == "-p" || arg == "--prompt" {
					t.Fatalf("cmd = %#v unexpectedly uses non-interactive prompt mode", cmd)
				}
				if tt.wantAbsent != "" && arg == tt.wantAbsent {
					t.Fatalf("cmd = %#v unexpectedly contains %q", cmd, tt.wantAbsent)
				}
			}
		})
	}
}

func TestGetLaunchCommandIgnoresSystemPrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "kimi"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPrompt:     "follow repo rules",
		SystemPromptFile: "/tmp/system.md",
		Prompt:           "do the thing",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Kimi has no documented system-prompt flag, and prompted tasks are injected
	// after startup rather than through non-interactive `-p`.
	want := []string{"kimi"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

// Kimi docs: `--yolo` and `--auto` cannot be used together with `--continue`
// or `--session` — resumed sessions inherit the approval settings of the
// original session — so the restore path must not emit approval flags
// regardless of the requested AO PermissionMode.
func TestGetRestoreCommand(t *testing.T) {
	modes := []ports.PermissionMode{
		ports.PermissionModeDefault,
		"",
		ports.PermissionModeAcceptEdits,
		ports.PermissionModeAuto,
		ports.PermissionModeBypassPermissions,
	}

	for _, mode := range modes {
		t.Run(string(mode), func(t *testing.T) {
			p := &Plugin{resolvedBinary: "kimi"}
			cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
				Session: ports.SessionRef{
					Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "01HZABC"},
				},
				Permissions: mode,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !ok {
				t.Fatal("ok=false, want true")
			}

			want := []string{"kimi", "--session", "01HZABC"}
			if !reflect.DeepEqual(cmd, want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, want)
			}
			for _, arg := range cmd {
				switch arg {
				case "--auto", "-y", "--yolo", "--yes", "--auto-approve", "--plan":
					t.Fatalf("cmd = %#v unexpectedly contains approval/plan flag %q", cmd, arg)
				}
			}
		})
	}
}

func TestGetRestoreCommandNoID(t *testing.T) {
	p := &Plugin{resolvedBinary: "kimi"}

	cases := []struct {
		name string
		ref  ports.SessionRef
	}{
		{"empty session ref", ports.SessionRef{}},
		{"empty metadata", ports.SessionRef{Metadata: map[string]string{}}},
		{"blank agent session metadata", ports.SessionRef{Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "   "}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{Session: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				t.Fatal("ok=true with no agentSessionId, want false")
			}
			if cmd != nil {
				t.Fatalf("cmd = %#v, want nil", cmd)
			}
		})
	}
}

func TestGetAgentHooksNoOp(t *testing.T) {
	if err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: t.TempDir()}); err != nil {
		t.Fatalf("GetAgentHooks err = %v, want nil", err)
	}
}

func TestSessionInfoNoOp(t *testing.T) {
	info, ok, err := (&Plugin{}).SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "01HZABC"},
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
	if _, err := ResolveKimiBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ResolveKimiBinary err = %v, want context.Canceled", err)
	}
}
