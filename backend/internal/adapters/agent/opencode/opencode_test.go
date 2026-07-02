package opencode

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGetLaunchCommandBuildsArgv(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:      ports.PermissionModeBypassPermissions,
		Prompt:           "-fix this",
		SystemPromptFile: filepath.Join("tmp", "prompt with spaces.md"),
		SystemPrompt:     "ignored",
	})
	if err != nil {
		t.Fatal(err)
	}

	// opencode has no system-prompt flag, so SystemPrompt/SystemPromptFile are
	// dropped; the prompt is delivered via --prompt.
	want := []string{
		"opencode",
		"--dangerously-skip-permissions",
		"--prompt", "-fix this",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandMapsPermissionModes(t *testing.T) {
	tests := []struct {
		name        string
		permission  ports.PermissionMode
		wantFlag    bool
		notExpected string
	}{
		{name: "default", permission: ports.PermissionModeDefault, notExpected: "--dangerously-skip-permissions"},
		{name: "accept-edits", permission: ports.PermissionModeAcceptEdits, notExpected: "--dangerously-skip-permissions"},
		{name: "auto", permission: ports.PermissionModeAuto, notExpected: "--dangerously-skip-permissions"},
		{name: "bypass-permissions", permission: ports.PermissionModeBypassPermissions, wantFlag: true},
		{name: "empty", permission: "", notExpected: "--dangerously-skip-permissions"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plugin := &Plugin{resolvedBinary: "opencode"}
			cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{Permissions: tt.permission})
			if err != nil {
				t.Fatal(err)
			}
			has := contains(cmd, "--dangerously-skip-permissions")
			if tt.wantFlag && !has {
				t.Fatalf("command %#v missing --dangerously-skip-permissions", cmd)
			}
			if tt.notExpected != "" && has {
				t.Fatalf("command %#v contains %q", cmd, tt.notExpected)
			}
		})
	}
}

func TestGetPromptDeliveryStrategyIsInCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}

	got, err := plugin.GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("unexpected strategy: %q", got)
	}
}

func TestGetConfigSpecHasNoCustomFieldsYet(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}

	spec, err := plugin.GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 0 {
		t.Fatalf("unexpected config fields: %#v", spec.Fields)
	}
}

func TestGetAgentHooksInstallsPlugin(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}
	workspace := t.TempDir()

	// A user's own plugin in the same dir must survive AO's install untouched.
	pluginDir := filepath.Dir(opencodePluginPath(workspace))
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	userPlugin := filepath.Join(pluginDir, "user.js")
	userBody := []byte("export const userPlugin = async () => ({})\n")
	if err := os.WriteFile(userPlugin, userBody, 0o644); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	cfg := ports.WorkspaceHookConfig{DataDir: t.TempDir(), SessionID: "sess-1", WorkspacePath: workspace}
	if err := plugin.GetAgentHooks(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	// A second install must be idempotent (overwrite with identical content).
	if err := plugin.GetAgentHooks(ctx, cfg); err != nil {
		t.Fatal(err)
	}

	if installed, err := plugin.AreHooksInstalled(ctx, workspace); err != nil || !installed {
		t.Fatalf("AreHooksInstalled after install = (%v, %v), want (true, nil)", installed, err)
	}

	data, err := os.ReadFile(opencodePluginPath(workspace))
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	if !strings.Contains(body, opencodePluginSentinel) {
		t.Fatalf("installed plugin missing AO sentinel:\n%s", body)
	}
	// Every normalized activity event must be wired via `ao hooks opencode <event>`.
	for _, event := range opencodeManagedEvents {
		want := opencodeHookCommandPrefix + event
		if !strings.Contains(body, want) {
			t.Fatalf("installed plugin missing hook command %q:\n%s", want, body)
		}
	}
	// The opencode-native lifecycle events the plugin subscribes to. Stop maps
	// to session.status(idle) — NOT the deprecated session.idle — and the user
	// prompt is detected from message.updated/message.part.updated.
	for _, marker := range []string{"session.created", "message.updated", "message.part.updated", "session.status"} {
		if !strings.Contains(body, marker) {
			t.Fatalf("installed plugin missing opencode event %q:\n%s", marker, body)
		}
	}
	// Guard against regressing back to subscribing to the deprecated/unreliable
	// session.idle event (the quoted event string is how a `case` would name it;
	// the explanatory comment mentions it unquoted, which is fine).
	if strings.Contains(body, `"session.idle"`) {
		t.Fatalf("plugin subscribes to deprecated session.idle; use session.status(idle):\n%s", body)
	}
	// A hung `ao hooks` call must not block opencode forever, so each spawn is
	// time-boxed (parity with the claude/codex 30s hook timeout).
	if !strings.Contains(body, "timeout:") {
		t.Fatalf("plugin spawn has no timeout; a hung hook would block opencode:\n%s", body)
	}

	// The user's plugin is untouched.
	got, err := os.ReadFile(userPlugin)
	if err != nil {
		t.Fatalf("user plugin removed by install: %v", err)
	}
	if !reflect.DeepEqual(got, userBody) {
		t.Fatalf("user plugin modified by install: %q", got)
	}
}

func TestGetAgentHooksRefusesToClobberForeignFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}
	workspace := t.TempDir()
	ctx := context.Background()

	// A non-AO file occupying AO's exact path must NOT be silently overwritten.
	pluginPath := opencodePluginPath(workspace)
	if err := os.MkdirAll(filepath.Dir(pluginPath), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("export const notOurs = async () => ({})\n")
	if err := os.WriteFile(pluginPath, foreign, 0o644); err != nil {
		t.Fatal(err)
	}

	err := plugin.GetAgentHooks(ctx, ports.WorkspaceHookConfig{WorkspacePath: workspace})
	if err == nil {
		t.Fatal("GetAgentHooks overwrote a non-AO file; want a loud error")
	}
	got, readErr := os.ReadFile(pluginPath)
	if readErr != nil {
		t.Fatalf("foreign file removed by refused install: %v", readErr)
	}
	if !reflect.DeepEqual(got, foreign) {
		t.Fatalf("foreign file modified by refused install: %q", got)
	}
}

func TestUninstallHooksRemovesPlugin(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}
	workspace := t.TempDir()
	ctx := context.Background()
	cfg := ports.WorkspaceHookConfig{DataDir: t.TempDir(), SessionID: "sess-1", WorkspacePath: workspace}

	// Pre-seed a user's own plugin; it must survive uninstall.
	pluginDir := filepath.Dir(opencodePluginPath(workspace))
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	userPlugin := filepath.Join(pluginDir, "user.js")
	if err := os.WriteFile(userPlugin, []byte("export const userPlugin = async () => ({})\n"), 0o644); err != nil {
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
	if _, err := os.Stat(opencodePluginPath(workspace)); !os.IsNotExist(err) {
		t.Fatalf("AO plugin still present after uninstall: err=%v", err)
	}
	if _, err := os.Stat(userPlugin); err != nil {
		t.Fatalf("user plugin removed by uninstall: %v", err)
	}
}

func TestUninstallHooksLeavesForeignFile(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}
	workspace := t.TempDir()
	ctx := context.Background()

	// A non-AO file occupying AO's filename must NOT be deleted by uninstall.
	pluginPath := opencodePluginPath(workspace)
	if err := os.MkdirAll(filepath.Dir(pluginPath), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("export const notOurs = async () => ({})\n")
	if err := os.WriteFile(pluginPath, foreign, 0o644); err != nil {
		t.Fatal(err)
	}

	if installed, err := plugin.AreHooksInstalled(ctx, workspace); err != nil || installed {
		t.Fatalf("AreHooksInstalled on foreign file = (%v, %v), want (false, nil)", installed, err)
	}
	if err := plugin.UninstallHooks(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(pluginPath)
	if err != nil {
		t.Fatalf("foreign file removed by uninstall: %v", err)
	}
	if !reflect.DeepEqual(got, foreign) {
		t.Fatalf("foreign file modified by uninstall: %q", got)
	}
}

func TestGetRestoreCommandReadsAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}

	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeBypassPermissions,
		Session: ports.SessionRef{
			Metadata: map[string]string{opencodeAgentSessionIDMetadataKey: "ses_abc123"},
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatal("ok = false, want true")
	}
	want := []string{
		"opencode",
		"--dangerously-skip-permissions",
		"--session", "ses_abc123",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("restore cmd\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetRestoreCommandFalseWithoutAgentSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}

	cases := []struct {
		name string
		ref  ports.SessionRef
	}{
		{"empty session ref", ports.SessionRef{}},
		{"empty metadata", ports.SessionRef{Metadata: map[string]string{}}},
		{"blank agent session metadata", ports.SessionRef{Metadata: map[string]string{opencodeAgentSessionIDMetadataKey: "   "}}},
		{"workspace path only", ports.SessionRef{WorkspacePath: "/some/path"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
				Permissions: ports.PermissionModeDefault,
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
	plugin := &Plugin{resolvedBinary: "opencode"}

	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		WorkspacePath: "/some/path",
		Metadata: map[string]string{
			opencodeAgentSessionIDMetadataKey: "ses_abc123",
			ports.MetadataKeyTitle:            "Fix login redirect",
			ports.MetadataKeySummary:          "Updated the auth callback and tests.",
			"ignored":                         "not returned",
		},
	})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.AgentSessionID != "ses_abc123" {
		t.Fatalf("AgentSessionID = %q, want native id", info.AgentSessionID)
	}
	if info.Title != "Fix login redirect" {
		t.Fatalf("Title = %q, want hook title", info.Title)
	}
	if info.Summary != "Updated the auth callback and tests." {
		t.Fatalf("Summary = %q, want hook summary", info.Summary)
	}
	if info.Metadata != nil {
		t.Fatalf("Metadata = %#v, want nil for opencode", info.Metadata)
	}
}

func TestSessionInfoFalseWhenNoHookMetadata(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "opencode"}

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

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
