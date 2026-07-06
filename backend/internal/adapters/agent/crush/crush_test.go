package crush

import (
	"context"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGetLaunchCommandBuildsCrossPlatformArgv(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "crush"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "fix this",
		WorkspacePath: "/tmp/workspace",
		SessionID:     "test-session-id",
	})
	if err != nil {
		t.Fatal(err)
	}

	// cfg.SessionID is the AO-internal id and must NOT be passed as --session on
	// launch; Crush mints its own native id, which GetRestoreCommand resumes by.
	want := []string{
		"crush",
		"--cwd", "/tmp/workspace",
		"--yolo",
		"--", "fix this",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandMapsPermissionModes(t *testing.T) {
	tests := []struct {
		name        string
		permission  ports.PermissionMode
		want        []string
		notExpected string
	}{
		{
			name:        "default",
			permission:  ports.PermissionModeDefault,
			notExpected: "--yolo",
		},
		{
			name:        "accept-edits",
			permission:  ports.PermissionModeAcceptEdits,
			want:        nil, // Crush doesn't have granular permission modes
			notExpected: "--yolo",
		},
		{
			name:        "auto",
			permission:  ports.PermissionModeAuto,
			want:        nil, // Crush doesn't have granular permission modes
			notExpected: "--yolo",
		},
		{
			name:       "bypass-permissions",
			permission: ports.PermissionModeBypassPermissions,
			want:       []string{"--yolo"},
		},
		{
			name:        "empty",
			permission:  "",
			notExpected: "--yolo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plugin := &Plugin{resolvedBinary: "crush"}
			cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
				Permissions: tt.permission,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(tt.want) > 0 && !containsSubsequence(cmd, tt.want) {
				t.Fatalf("command %#v does not contain %#v", cmd, tt.want)
			}
			if tt.notExpected != "" && contains(cmd, tt.notExpected) {
				t.Fatalf("command %#v contains %q", cmd, tt.notExpected)
			}
		})
	}
}

func TestGetPromptDeliveryStrategyIsInCommand(t *testing.T) {
	plugin := &Plugin{}

	got, err := plugin.GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}

	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("unexpected prompt delivery strategy: got %v, want %v", got, ports.PromptDeliveryInCommand)
	}
}

func TestGetRestoreCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "crush"}

	tests := []struct {
		name           string
		agentSessionID string
		workspacePath  string
		permission     ports.PermissionMode
		wantOk         bool
		wantContains   []string
	}{
		{
			name:           "restore with session id",
			agentSessionID: "crush-session-123",
			workspacePath:  "/tmp/workspace",
			permission:     ports.PermissionModeDefault,
			wantOk:         true,
			wantContains:   []string{"--cwd", "/tmp/workspace", "--session", "crush-session-123"},
		},
		{
			name:           "restore with bypass permissions",
			agentSessionID: "crush-session-456",
			workspacePath:  "/tmp/workspace",
			permission:     ports.PermissionModeBypassPermissions,
			wantOk:         true,
			wantContains:   []string{"--cwd", "/tmp/workspace", "--yolo", "--session", "crush-session-456"},
		},
		{
			name:           "no session id",
			agentSessionID: "",
			wantOk:         false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
				Session: ports.SessionRef{
					Metadata:      map[string]string{"agentSessionId": tt.agentSessionID},
					WorkspacePath: tt.workspacePath,
				},
				Permissions: tt.permission,
			})
			if err != nil {
				t.Fatal(err)
			}
			if ok != tt.wantOk {
				t.Fatalf("unexpected ok: got %v, want %v", ok, tt.wantOk)
			}
			if tt.wantOk && len(tt.wantContains) > 0 && !containsSubsequence(cmd, tt.wantContains) {
				t.Fatalf("command %#v does not contain %#v", cmd, tt.wantContains)
			}
		})
	}
}

func TestSessionInfoReturnsFalse(t *testing.T) {
	plugin := &Plugin{}

	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		ID:       "session-123",
		Metadata: map[string]string{"agentSessionId": "crush-session-123"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("unexpected ok: got true, want false (SessionInfo is a no-op for Crush)")
	}
	if info.AgentSessionID != "" || info.Title != "" || info.Summary != "" {
		t.Fatalf("unexpected non-empty info: got %#v", info)
	}
}

func TestManifest(t *testing.T) {
	plugin := &Plugin{}

	manifest := plugin.Manifest()
	if manifest.ID != adapterID {
		t.Fatalf("unexpected manifest ID: got %q, want %q", manifest.ID, adapterID)
	}
	if manifest.Name != "Crush" {
		t.Fatalf("unexpected manifest name: got %q, want \"Crush\"", manifest.Name)
	}
	if len(manifest.Capabilities) != 1 {
		t.Fatalf("unexpected capabilities count: got %d, want 1", len(manifest.Capabilities))
	}
}

func TestGetConfigSpecReturnsEmpty(t *testing.T) {
	plugin := &Plugin{}

	spec, err := plugin.GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 0 {
		t.Fatalf("unexpected config spec fields: got %d, want 0", len(spec.Fields))
	}
}

func TestGetAgentHooksIsNoOp(t *testing.T) {
	plugin := &Plugin{}

	err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{
		WorkspacePath: "/tmp/workspace",
	})
	if err != nil {
		t.Fatalf("unexpected error from GetAgentHooks (no-op): %v", err)
	}
}

func TestUninstallHooksIsNoOp(t *testing.T) {
	plugin := &Plugin{}

	err := plugin.UninstallHooks(context.Background(), "/tmp/workspace")
	if err != nil {
		t.Fatalf("unexpected error from UninstallHooks (no-op): %v", err)
	}
}

func TestAreHooksInstalledReturnsFalse(t *testing.T) {
	plugin := &Plugin{}

	installed, err := plugin.AreHooksInstalled(context.Background(), "/tmp/workspace")
	if err != nil {
		t.Fatalf("unexpected error from AreHooksInstalled (no-op): %v", err)
	}
	if installed {
		t.Fatalf("unexpected installed status: got true, want false (hooks are no-op for Crush)")
	}
}

// Helper functions from codex_test.go

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func containsSubsequence(haystack, needle []string) bool {
	for i := 0; i <= len(haystack)-len(needle); i++ {
		match := true
		for j, n := range needle {
			if haystack[i+j] != n {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
