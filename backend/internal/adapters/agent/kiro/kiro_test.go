package kiro

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifestIDIsKiro(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "kiro" {
		t.Fatalf("manifest ID = %q, want %q", m.ID, "kiro")
	}
	if m.Name != "Kiro" {
		t.Fatalf("manifest Name = %q, want %q", m.Name, "Kiro")
	}
	if len(m.Capabilities) != 1 || m.Capabilities[0] != adapters.CapabilityAgent {
		t.Fatalf("manifest Capabilities = %#v, want [CapabilityAgent]", m.Capabilities)
	}
}

func TestGetLaunchCommandBuildsHeadlessArgv(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions: ports.PermissionModeBypassPermissions,
		Prompt:      "-fix this",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"kiro-cli", "chat", "--no-interactive",
		"--trust-all-tools",
		"--", "-fix this",
	}
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
			notExpected: []string{"--trust-all-tools", "--trust-tools=fs_read,fs_write"},
		},
		{
			name:       "accept-edits",
			permission: ports.PermissionModeAcceptEdits,
			want:       []string{"--trust-tools=fs_read,fs_write"},
		},
		{
			name:       "auto",
			permission: ports.PermissionModeAuto,
			want:       []string{"--trust-all-tools"},
		},
		{
			name:       "bypass-permissions",
			permission: ports.PermissionModeBypassPermissions,
			want:       []string{"--trust-all-tools"},
		},
		{
			name:        "empty",
			permission:  "",
			notExpected: []string{"--trust-all-tools", "--trust-tools=fs_read,fs_write"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plugin := &Plugin{resolvedBinary: "kiro-cli"}
			cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
				Permissions: tt.permission,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(tt.want) > 0 && !containsSubsequence(cmd, tt.want) {
				t.Fatalf("command %#v does not contain %#v", cmd, tt.want)
			}
			for _, missing := range tt.notExpected {
				if contains(cmd, missing) {
					t.Fatalf("command %#v contains %q", cmd, missing)
				}
			}
		})
	}
}

func TestGetLaunchCommandCtxCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	plugin := &Plugin{}
	if _, err := plugin.GetLaunchCommand(ctx, ports.LaunchConfig{}); err == nil {
		t.Fatal("expected error from cancelled context, got nil")
	}
}

func TestGetPromptDeliveryStrategyIsInCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

	got, err := plugin.GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("unexpected strategy: %q", got)
	}
}

func TestGetConfigSpecHasNoCustomFieldsYet(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

	spec, err := plugin.GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 0 {
		t.Fatalf("unexpected config fields: %#v", spec.Fields)
	}
}

func TestAuthStatusUsesKiroWhoami(t *testing.T) {
	restore := stubKiroAuthRunner(t, func(_ context.Context, name string, arg ...string) ([]byte, error) {
		if name != "kiro-cli" {
			t.Fatalf("binary = %q, want kiro-cli", name)
		}
		if !reflect.DeepEqual(arg, []string{"whoami"}) {
			t.Fatalf("args = %#v, want [whoami]", arg)
		}
		return []byte("Logged in with Google\nEmail: nicachale456@gmail.com\n"), nil
	})
	defer restore()

	plugin := &Plugin{resolvedBinary: "kiro-cli"}
	status, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusAuthorized)
	}
}

func TestAuthStatusUnauthorizedFromKiroWhoami(t *testing.T) {
	restore := stubKiroAuthRunner(t, func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("Not logged in\n"), nil
	})
	defer restore()

	plugin := &Plugin{resolvedBinary: "kiro-cli"}
	status, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusUnauthorized)
	}
}

func TestGetAgentHooksInstallsKiroHooks(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}
	workspace := t.TempDir()
	hooksDir := filepath.Join(workspace, kiroHooksDirName, kiroAgentsDirName)
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	hooksPath := filepath.Join(hooksDir, kiroAgentFileName)
	existing := `{"name":"ao","hooks":{"stop":[{"command":"custom stop hook"}]}}`
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
	// The unmanaged top-level "name" key must be preserved.
	var topLevel map[string]json.RawMessage
	if err := json.Unmarshal(data, &topLevel); err != nil {
		t.Fatal(err)
	}
	if _, ok := topLevel["name"]; !ok {
		t.Fatalf("unmanaged top-level key 'name' was dropped: %s", data)
	}

	var config kiroHookFile
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if config.Hooks == nil {
		t.Fatalf("hooks config missing hooks object: %#v", config)
	}
	for _, spec := range kiroManagedHooks {
		entries := config.Hooks[spec.Event]
		if count := countKiroHookCommand(entries, spec.Command); count != 1 {
			t.Fatalf("%s command count = %d, want 1 in %#v", spec.Event, count, entries)
		}
	}
	stopEntries := config.Hooks["stop"]
	if countKiroHookCommand(stopEntries, "custom stop hook") != 1 {
		t.Fatalf("existing stop hook was not preserved: %#v", stopEntries)
	}
}

func TestUninstallHooksRemovesKiroHooks(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}
	workspace := t.TempDir()
	hooksPath := kiroAgentPath(workspace)

	ctx := context.Background()
	cfg := ports.WorkspaceHookConfig{DataDir: t.TempDir(), SessionID: "sess-1", WorkspacePath: workspace}

	// Pre-seed a user's own stop hook; it must survive uninstall.
	if err := os.MkdirAll(filepath.Dir(hooksPath), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := `{"hooks":{"stop":[{"command":"custom stop hook"}]}}`
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
	var config kiroHookFile
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	for _, spec := range kiroManagedHooks {
		if got := countKiroHookCommand(config.Hooks[spec.Event], spec.Command); got != 0 {
			t.Fatalf("%s command %q count = %d after uninstall, want 0", spec.Event, spec.Command, got)
		}
	}
	if countKiroHookCommand(config.Hooks["stop"], "custom stop hook") != 1 {
		t.Fatalf("user stop hook not preserved: %#v", config.Hooks["stop"])
	}
}

func TestAreHooksInstalledMissingFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}
	workspace := t.TempDir()
	installed, err := plugin.AreHooksInstalled(context.Background(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("AreHooksInstalled = true for missing file, want false")
	}
}

func TestGetRestoreCommandReadsAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeAuto,
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "uuid-123"},
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatal("ok = false, want true")
	}
	want := []string{
		"kiro-cli", "chat", "--no-interactive",
		"--resume-id", "uuid-123",
		"--trust-all-tools",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("restore cmd\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetRestoreCommandFalseWithoutAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

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
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		WorkspacePath: "/some/path",
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "uuid-123",
			kiroTitleMetadataKey:            "Fix login redirect",
			kiroSummaryMetadataKey:          "Updated the auth callback and tests.",
			"ignored":                       "not returned",
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.AgentSessionID != "uuid-123" {
		t.Fatalf("AgentSessionID = %q, want native id", info.AgentSessionID)
	}
	if info.Title != "Fix login redirect" {
		t.Fatalf("Title = %q, want hook title", info.Title)
	}
	if info.Summary != "Updated the auth callback and tests." {
		t.Fatalf("Summary = %q, want hook summary", info.Summary)
	}
	if info.Metadata != nil {
		t.Fatalf("Metadata = %#v, want nil for Kiro", info.Metadata)
	}
}

func TestSessionInfoFalseWhenNoHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "kiro-cli"}

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

func TestDeriveActivityState(t *testing.T) {
	tests := []struct {
		event     string
		wantState domain.ActivityState
		wantOK    bool
	}{
		{"session-start", domain.ActivityActive, true},
		{"user-prompt-submit", domain.ActivityActive, true},
		{"stop", domain.ActivityIdle, true},
		{"permission-request", domain.ActivityWaitingInput, true},
		{"unknown", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.event, func(t *testing.T) {
			state, ok := DeriveActivityState(tt.event, nil)
			if state != tt.wantState || ok != tt.wantOK {
				t.Fatalf("DeriveActivityState(%q) = (%q, %v), want (%q, %v)", tt.event, state, ok, tt.wantState, tt.wantOK)
			}
		})
	}
}

func TestResolveKiroBinaryFallback(t *testing.T) {
	// When the binary is not on PATH or any well-known location, the resolver
	// MUST surface ports.ErrAgentBinaryNotFound rather than a silent string
	// fallback that lets a missing CLI launch into an empty tmux pane.
	bin, err := ResolveKiroBinary(context.Background())
	if err != nil {
		if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
			t.Fatalf("err = %v, want ports.ErrAgentBinaryNotFound", err)
		}
		return
	}
	if bin == "" {
		t.Fatal("ResolveKiroBinary returned empty path with no error")
	}
}

func TestResolveKiroBinaryCtxCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ResolveKiroBinary(ctx); err == nil {
		t.Fatal("expected error from cancelled context, got nil")
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

func stubKiroAuthRunner(t *testing.T, runner func(context.Context, string, ...string) ([]byte, error)) func() {
	t.Helper()
	previous := authprobe.CmdRunner
	authprobe.CmdRunner = runner
	return func() { authprobe.CmdRunner = previous }
}

func countKiroHookCommand(entries []kiroHookEntry, command string) int {
	count := 0
	for _, entry := range entries {
		if entry.Command == command {
			count++
		}
	}
	return count
}
