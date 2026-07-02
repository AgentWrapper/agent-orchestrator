package cline

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGetLaunchCommandBuildsCrossPlatformArgv(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:  ports.PermissionModeBypassPermissions,
		Prompt:       "-fix this",
		SystemPrompt: "be careful",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"cline",
		"--json",
		"--yolo",
		"-s", "be careful",
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
		notExpected string
	}{
		{
			name:        "default",
			permission:  ports.PermissionModeDefault,
			notExpected: "--auto-approve",
		},
		{
			name:       "accept-edits",
			permission: ports.PermissionModeAcceptEdits,
			want:       []string{"--auto-approve", "true"},
		},
		{
			name:       "auto",
			permission: ports.PermissionModeAuto,
			want:       []string{"--auto-approve", "true"},
		},
		{
			name:       "bypass-permissions",
			permission: ports.PermissionModeBypassPermissions,
			want:       []string{"--yolo"},
		},
		{
			name:        "empty",
			permission:  "",
			notExpected: "--auto-approve",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plugin := &Plugin{resolvedBinary: "cline"}
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
	plugin := &Plugin{resolvedBinary: "cline"}

	got, err := plugin.GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("unexpected strategy: %q", got)
	}
}

func TestGetConfigSpecHasNoCustomFieldsYet(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}

	spec, err := plugin.GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 0 {
		t.Fatalf("unexpected config fields: %#v", spec.Fields)
	}
}

func TestManifestIDMatchesHarness(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "cline" {
		t.Fatalf("manifest ID = %q, want %q", m.ID, "cline")
	}
	if m.Name != "Cline" {
		t.Fatalf("manifest Name = %q, want %q", m.Name, "Cline")
	}
}

func TestGetAgentHooksInstallsClineHooks(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}
	workspace := t.TempDir()
	hooksDir := filepath.Join(workspace, clineHooksDirName, clineHooksSubDir)

	// Pre-seed a user's own hook script; it must survive install.
	if err := os.MkdirAll(hooksDir, 0o750); err != nil {
		t.Fatal(err)
	}
	userHook := filepath.Join(hooksDir, "PostToolUse")
	if err := os.WriteFile(userHook, []byte("#!/usr/bin/env bash\necho '{\"cancel\": false}'\n"), 0o700); err != nil {
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
	// A second install must be idempotent (no error, scripts still single).
	if err := plugin.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}

	for _, spec := range clineManagedHooks {
		scriptPath := filepath.Join(hooksDir, spec.Event)
		data, err := os.ReadFile(scriptPath)
		if err != nil {
			t.Fatalf("read %s: %v", spec.Event, err)
		}
		content := string(data)
		if !strings.Contains(content, clineHookMarker) {
			t.Fatalf("%s missing AO marker:\n%s", spec.Event, content)
		}
		if !strings.Contains(content, clineHookCommandPrefix+spec.Subcommand) {
			t.Fatalf("%s missing forward command %q:\n%s", spec.Event, clineHookCommandPrefix+spec.Subcommand, content)
		}
		info, err := os.Stat(scriptPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o100 == 0 {
			t.Fatalf("%s is not executable: %v", spec.Event, info.Mode())
		}
	}

	// User-authored hook untouched.
	data, err := os.ReadFile(userHook)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), clineHookMarker) {
		t.Fatalf("user PostToolUse hook was overwritten by AO: %s", data)
	}
}

func TestGetAgentHooksRequiresWorkspacePath(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}
	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{}); err == nil {
		t.Fatal("expected error for empty WorkspacePath")
	}
}

func TestUninstallHooksRemovesClineHooks(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}
	workspace := t.TempDir()
	hooksDir := filepath.Join(workspace, clineHooksDirName, clineHooksSubDir)

	ctx := context.Background()
	cfg := ports.WorkspaceHookConfig{DataDir: t.TempDir(), SessionID: "sess-1", WorkspacePath: workspace}

	// Pre-seed a user's own hook; it must survive uninstall.
	if err := os.MkdirAll(hooksDir, 0o750); err != nil {
		t.Fatal(err)
	}
	userHook := filepath.Join(hooksDir, "PostToolUse")
	if err := os.WriteFile(userHook, []byte("#!/usr/bin/env bash\necho '{\"cancel\": false}'\n"), 0o700); err != nil {
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

	for _, spec := range clineManagedHooks {
		if fileExists(filepath.Join(hooksDir, spec.Event)) {
			t.Fatalf("%s still present after uninstall", spec.Event)
		}
	}
	if !fileExists(userHook) {
		t.Fatal("user PostToolUse hook was removed by uninstall")
	}
}

func TestUninstallHooksMissingDirIsNoOp(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}
	if err := plugin.UninstallHooks(context.Background(), t.TempDir()); err != nil {
		t.Fatalf("uninstall on missing hooks dir = %v, want nil", err)
	}
}

func TestGetRestoreCommandReadsAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}

	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeAuto,
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "session-123"},
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatal("ok = false, want true")
	}
	want := []string{
		"cline",
		"--json",
		"--auto-approve", "true",
		"--id", "session-123",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("restore cmd\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetRestoreCommandFalseWithoutAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}

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
	plugin := &Plugin{resolvedBinary: "cline"}

	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		WorkspacePath: "/some/path",
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "session-123",
			clineTitleMetadataKey:           "Fix login redirect",
			clineSummaryMetadataKey:         "Updated the auth callback and tests.",
			"ignored":                       "not returned",
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.AgentSessionID != "session-123" {
		t.Fatalf("AgentSessionID = %q, want native id", info.AgentSessionID)
	}
	if info.Title != "Fix login redirect" {
		t.Fatalf("Title = %q, want hook title", info.Title)
	}
	if info.Summary != "Updated the auth callback and tests." {
		t.Fatalf("Summary = %q, want hook summary", info.Summary)
	}
	if info.Metadata != nil {
		t.Fatalf("Metadata = %#v, want nil for Cline", info.Metadata)
	}
}

func TestSessionInfoFalseWhenNoHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}

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
		event  string
		want   domain.ActivityState
		wantOK bool
	}{
		{"session-start", domain.ActivityActive, true},
		{"user-prompt-submit", domain.ActivityActive, true},
		{"stop", domain.ActivityIdle, true},
		{"permission-request", domain.ActivityBlocked, true},
		{"unknown", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.event, func(t *testing.T) {
			got, ok := DeriveActivityState(tt.event, nil)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("DeriveActivityState(%q) = (%q, %v), want (%q, %v)", tt.event, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestContextCancellationIsHonored(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "cline"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := plugin.GetLaunchCommand(ctx, ports.LaunchConfig{}); err == nil {
		// GetLaunchCommand resolves the cached binary first; ctx.Err is checked
		// inside ResolveClineBinary only when no cached binary. With a cached
		// binary it may not error, so we assert the other methods instead.
		_ = err
	}
	if _, err := plugin.GetConfigSpec(ctx); err == nil {
		t.Fatal("GetConfigSpec: expected context error")
	}
	if _, err := plugin.GetPromptDeliveryStrategy(ctx, ports.LaunchConfig{}); err == nil {
		t.Fatal("GetPromptDeliveryStrategy: expected context error")
	}
	if _, _, err := plugin.GetRestoreCommand(ctx, ports.RestoreConfig{}); err == nil {
		t.Fatal("GetRestoreCommand: expected context error")
	}
	if _, _, err := plugin.SessionInfo(ctx, ports.SessionRef{}); err == nil {
		t.Fatal("SessionInfo: expected context error")
	}
	if err := plugin.GetAgentHooks(ctx, ports.WorkspaceHookConfig{WorkspacePath: "/x"}); err == nil {
		t.Fatal("GetAgentHooks: expected context error")
	}
	if _, err := ResolveClineBinary(ctx); err == nil {
		t.Fatal("ResolveClineBinary: expected context error")
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
