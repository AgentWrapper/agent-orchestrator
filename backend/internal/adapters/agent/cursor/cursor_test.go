package cursor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGetLaunchCommandBuildsArgv(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:      ports.PermissionModeBypassPermissions,
		Prompt:           "-fix this",
		SystemPromptFile: filepath.Join("tmp", "prompt with spaces.md"),
		SystemPrompt:     "ignored",
	})
	if err != nil {
		t.Fatal(err)
	}

	// System prompt is never injected via a flag for cursor; the prompt is
	// positional and last, guarded by a `--` end-of-options sentinel so a
	// leading "-" is not parsed as a flag.
	want := []string{
		"cursor-agent",
		"--force",
		"--", "-fix this",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandOmitsPromptWhenEmpty(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions: ports.PermissionModeDefault,
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"cursor-agent"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandMapsApprovalModes(t *testing.T) {
	tests := []struct {
		name        string
		permission  ports.PermissionMode
		want        []string
		notExpected []string
	}{
		{
			name:        "default",
			permission:  ports.PermissionModeDefault,
			notExpected: []string{"--force", "--yolo"},
		},
		{
			name:        "accept-edits",
			permission:  ports.PermissionModeAcceptEdits,
			notExpected: []string{"--force", "--yolo"},
		},
		{
			name:        "auto",
			permission:  ports.PermissionModeAuto,
			want:        []string{"--force"},
			notExpected: []string{"--yolo"},
		},
		{
			name:        "bypass-permissions",
			permission:  ports.PermissionModeBypassPermissions,
			want:        []string{"--force"},
			notExpected: []string{"--yolo"},
		},
		{
			name:        "unknown falls back to default",
			permission:  "",
			notExpected: []string{"--force", "--yolo"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plugin := &Plugin{resolvedBinary: "cursor-agent"}
			cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
				Permissions: tt.permission,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(tt.want) > 0 && !containsSubsequence(cmd, tt.want) {
				t.Fatalf("command %#v does not contain %#v", cmd, tt.want)
			}
			for _, ne := range tt.notExpected {
				if contains(cmd, ne) {
					t.Fatalf("command %#v unexpectedly contains %q", cmd, ne)
				}
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
		t.Fatalf("unexpected strategy: %q", got)
	}
}

func TestGetConfigSpecHasNoCustomFieldsYet(t *testing.T) {
	plugin := &Plugin{}

	spec, err := plugin.GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 0 {
		t.Fatalf("unexpected config fields: %#v", spec.Fields)
	}
}

func TestGetRestoreCommandReadsAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}

	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeAuto,
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "chat-123"},
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatal("ok = false, want true")
	}
	want := []string{
		"cursor-agent",
		"--force",
		"--resume", "chat-123",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("restore cmd\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetRestoreCommandFalseWithoutAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}

	cases := []struct {
		name string
		ref  ports.SessionRef
	}{
		{"empty session ref", ports.SessionRef{}},
		{"empty metadata", ports.SessionRef{Metadata: map[string]string{}}},
		{"blank agent session metadata", ports.SessionRef{Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "   "}}},
		{"workspace path only", ports.SessionRef{WorkspacePath: "/some/path"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
				Permissions: ports.PermissionModeAuto,
				Session:     tc.ref,
			})
			if err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if ok {
				t.Fatalf("ok = true, want false")
			}
			if cmd != nil {
				t.Fatalf("cmd = %#v, want nil", cmd)
			}
		})
	}
}

func TestSessionInfoReadsHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}

	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		WorkspacePath: "/some/path",
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "chat-123",
			ports.MetadataKeyTitle:          "Fix login redirect",
			ports.MetadataKeySummary:        "Updated the auth callback and tests.",
			"ignored":                       "not returned",
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.AgentSessionID != "chat-123" {
		t.Fatalf("AgentSessionID = %q, want native id", info.AgentSessionID)
	}
	if info.Title != "Fix login redirect" {
		t.Fatalf("Title = %q, want hook title", info.Title)
	}
	if info.Summary != "Updated the auth callback and tests." {
		t.Fatalf("Summary = %q, want hook summary", info.Summary)
	}
	if info.Metadata != nil {
		t.Fatalf("Metadata = %#v, want nil for Cursor", info.Metadata)
	}
}

func TestSessionInfoFalseWhenNoHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}

	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		WorkspacePath: "/some/path",
		Metadata:      map[string]string{},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if ok {
		t.Fatalf("ok = true, want false")
	}
	if !reflect.DeepEqual(info, ports.SessionInfo{}) {
		t.Fatalf("info = %#v, want zero value", info)
	}
}

func TestContextCancellationPerMethod(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := plugin.GetConfigSpec(ctx); err == nil {
		t.Fatal("GetConfigSpec: want context error")
	}
	// GetLaunchCommand surfaces ctx cancellation only via binary resolution; with
	// a cached binary it short-circuits, so it is not asserted here (mirrors codex).
	if _, err := plugin.GetPromptDeliveryStrategy(ctx, ports.LaunchConfig{}); err == nil {
		t.Fatal("GetPromptDeliveryStrategy: want context error")
	}
	if _, _, err := plugin.GetRestoreCommand(ctx, ports.RestoreConfig{
		Session: ports.SessionRef{Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "chat-123"}},
	}); err == nil {
		t.Fatal("GetRestoreCommand: want context error")
	}
	if _, _, err := plugin.SessionInfo(ctx, ports.SessionRef{}); err == nil {
		t.Fatal("SessionInfo: want context error")
	}
	if err := plugin.GetAgentHooks(ctx, ports.WorkspaceHookConfig{WorkspacePath: t.TempDir()}); err == nil {
		t.Fatal("GetAgentHooks: want context error")
	}
	if err := plugin.UninstallHooks(ctx, t.TempDir()); err == nil {
		t.Fatal("UninstallHooks: want context error")
	}
	if _, err := plugin.AreHooksInstalled(ctx, t.TempDir()); err == nil {
		t.Fatal("AreHooksInstalled: want context error")
	}
}

func TestGetAgentHooksInstallsCursorHooks(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := t.TempDir()
	hooksDir := filepath.Join(workspace, ".cursor")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	hooksPath := filepath.Join(hooksDir, "hooks.json")
	// Pre-existing user hook on an event AO also manages, plus a non-AO field.
	existing := `{"version":1,"customField":"keep me","hooks":{"stop":[{"command":"custom stop hook"}]}}`
	if err := os.WriteFile(hooksPath, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := ports.WorkspaceHookConfig{
		DataDir:       t.TempDir(),
		SessionID:     "sess-1",
		WorkspacePath: workspace,
	}
	if err := plugin.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	// A second install must not duplicate AO hook commands.
	if err := plugin.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var config cursorHookFile
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if config.Hooks == nil {
		t.Fatalf("hooks config missing hooks object: %#v", config)
	}
	if config.Version != 1 {
		t.Fatalf("version = %d, want 1", config.Version)
	}
	for _, spec := range cursorManagedHooks {
		entries := config.Hooks[spec.Event]
		if count := countCursorHookCommand(entries, spec.Command); count != 1 {
			t.Fatalf("%s command %q count = %d, want 1 in %#v", spec.Event, spec.Command, count, entries)
		}
	}
	stopEntries := config.Hooks["stop"]
	if countCursorHookCommand(stopEntries, "custom stop hook") != 1 {
		t.Fatalf("existing stop hook was not preserved: %#v", stopEntries)
	}
	// Unmanaged top-level fields must be preserved.
	if !strings.Contains(string(data), "keep me") {
		t.Fatalf("unmanaged field 'customField' was dropped: %s", data)
	}
}

func TestUninstallHooksRemovesOnlyAOHooks(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := t.TempDir()
	hooksPath := filepath.Join(workspace, ".cursor", "hooks.json")

	ctx := context.Background()
	cfg := ports.WorkspaceHookConfig{DataDir: t.TempDir(), SessionID: "sess-1", WorkspacePath: workspace}

	// Pre-seed a user's own stop hook; it must survive uninstall.
	if err := os.MkdirAll(filepath.Dir(hooksPath), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := `{"version":1,"hooks":{"stop":[{"command":"custom stop hook"}]}}`
	if err := os.WriteFile(hooksPath, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := plugin.GetAgentHooks(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if installed, err := plugin.AreHooksInstalled(ctx, workspace); err != nil || !installed {
		t.Fatalf("AreHooksInstalled after install = (%v, %v), want (true, nil)", installed, err)
	}

	if err := plugin.UninstallHooks(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	if installed, err := plugin.AreHooksInstalled(ctx, workspace); err != nil || installed {
		t.Fatalf("AreHooksInstalled after uninstall = (%v, %v), want (false, nil)", installed, err)
	}

	data, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var config cursorHookFile
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	for _, spec := range cursorManagedHooks {
		if got := countCursorHookCommand(config.Hooks[spec.Event], spec.Command); got != 0 {
			t.Fatalf("%s command %q count = %d after uninstall, want 0", spec.Event, spec.Command, got)
		}
	}
	if countCursorHookCommand(config.Hooks["stop"], "custom stop hook") != 1 {
		t.Fatalf("user stop hook not preserved: %#v", config.Hooks["stop"])
	}
}

func TestAreHooksInstalledFalseWhenNoFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	workspace := t.TempDir()

	installed, err := plugin.AreHooksInstalled(context.Background(), workspace)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if installed {
		t.Fatal("installed = true, want false for missing file")
	}
}

func TestGetAgentHooksRequiresWorkspacePath(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cursor-agent"}
	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{}); err == nil {
		t.Fatal("want error for empty WorkspacePath")
	}
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func containsSubsequence(values []string, needle []string) bool {
	if len(needle) == 0 {
		return true
	}

	for start := range values {
		if start+len(needle) > len(values) {
			return false
		}
		ok := true
		for offset, want := range needle {
			if values[start+offset] != want {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}

	return false
}

func countCursorHookCommand(entries []cursorHookEntry, command string) int {
	count := 0
	for _, hook := range entries {
		if hook.Command == command {
			count++
		}
	}
	return count
}
