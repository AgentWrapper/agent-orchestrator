package agy

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	plugin := New()
	manifest := plugin.Manifest()
	if manifest.ID != "agy" {
		t.Fatalf("manifest id = %q, want agy", manifest.ID)
	}
}

func TestGetLaunchCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "fix this",
		WorkspacePath: "/tmp/ws",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"agy",
		"--add-dir", "/tmp/ws",
		"--dangerously-skip-permissions",
		"--prompt-interactive", "fix this",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetPromptDeliveryStrategy(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}
	got, err := plugin.GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("strategy = %q, want in_command", got)
	}
}

func TestGetRestoreCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeBypassPermissions,
		Session: ports.SessionRef{
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "native-id-123"},
			WorkspacePath: "/tmp/ws",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected ok=true")
	}

	want := []string{
		"agy",
		"--add-dir", "/tmp/ws",
		"--dangerously-skip-permissions",
		"--conversation", "native-id-123",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetRestoreCommandNoSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}
	_, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected ok=false when agentSessionId is missing")
	}
}

func TestSessionInfo(t *testing.T) {
	plugin := &Plugin{}
	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "native-id-123",
			"title":                         "My Title",
			"summary":                       "My Summary",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected ok=true")
	}
	if info.AgentSessionID != "native-id-123" || info.Title != "My Title" || info.Summary != "My Summary" {
		t.Fatalf("unexpected SessionInfo: %#v", info)
	}
}

func TestHooksLifecycle(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "agy-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	plugin := &Plugin{}
	cfg := ports.WorkspaceHookConfig{
		WorkspacePath: tmpDir,
	}

	// 1. Initially hooks should not be installed.
	installed, err := plugin.AreHooksInstalled(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("expected hooks to not be installed initially")
	}

	// 2. Install hooks.
	err = plugin.GetAgentHooks(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}

	installed, err = plugin.AreHooksInstalled(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if !installed {
		t.Fatal("expected hooks to be installed after GetAgentHooks")
	}

	// Verify hooks.json structure
	hooksJSONPath := filepath.Join(tmpDir, ".gemini", "hooks.json")
	data, err := os.ReadFile(hooksJSONPath)
	if err != nil {
		t.Fatal(err)
	}

	var hookFile agyHookFile
	if err := json.Unmarshal(data, &hookFile); err != nil {
		t.Fatal(err)
	}

	if len(hookFile.Hooks) != len(agyManagedHooks) {
		t.Fatalf("expected %d events in hooks, got %d", len(agyManagedHooks), len(hookFile.Hooks))
	}

	for _, spec := range agyManagedHooks {
		groups, ok := hookFile.Hooks[spec.Event]
		if !ok {
			t.Fatalf("expected event %q in hooks.json", spec.Event)
		}
		found := false
		for _, group := range groups {
			for _, h := range group.Hooks {
				if h.Command == spec.Command {
					found = true
					break
				}
			}
		}
		if !found {
			t.Fatalf("expected command %q for event %q", spec.Command, spec.Event)
		}
	}

	// 3. Uninstall hooks.
	err = plugin.UninstallHooks(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	installed, err = plugin.AreHooksInstalled(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("expected hooks to be uninstalled after UninstallHooks")
	}
}

func TestAuthStatus(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	status, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Errorf("AuthStatus() = %v, want AgentAuthStatusAuthorized", status)
	}
}
