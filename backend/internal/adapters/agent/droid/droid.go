// Package droid implements the Droid (Factory) agent adapter: launching new
// interactive sessions, resuming hook-tracked sessions, installing
// workspace-local hooks, and reading hook-derived session info.
//
// Droid is Factory's terminal coding agent (binary "droid"). Unlike Grok it has
// no Claude Code compatibility layer, so AO installs its own hooks into the
// worktree-local .factory/hooks.json (see hooks.go). The hook JSON structure
// matches Claude Code's, but Droid's Notification payload omits notification_type
// and its hooks live under .factory/, so the adapter ships its own activity
// deriver (see activity.go) rather than reusing Claude's.
//
// Launch uses the interactive `droid [prompt]` command (the prompt is a
// positional argument). Droid's interactive TUI exposes no per-launch permission
// flag (--auto / --skip-permissions-unsafe live only on `droid exec`), so AO's
// graduated permission modes are delivered by writing a process-scoped runtime
// settings file (sessionDefaultSettings.autonomyLevel) and passing it via the
// root `--settings <path>` flag. Restore prefers the hook-captured native
// session id via `-r <id>`.
package droid

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Plugin is the Droid agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Droid adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "droid",
		Name:        "Droid",
		Description: "Run Factory Droid worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a new interactive Droid session:
//
//	droid [--settings <path>] [--append-system-prompt[-file] <x>] [prompt]
//
// The prompt is delivered as a positional argument (in command). Droid resolves
// its model and other defaults from the user's own settings; only the autonomy
// level is overridden, and only for non-default permission modes (see
// permissionSettingsArgs). System-prompt text/file is appended (not replaced),
// matching Droid's --append-system-prompt semantics.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.droidBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = make([]string, 0, 6)
	cmd = append(cmd, binary)

	settingsArgs, err := permissionSettingsArgs(cfg.SessionID, cfg.Permissions)
	if err != nil {
		return nil, err
	}
	cmd = append(cmd, settingsArgs...)

	if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	} else if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "--append-system-prompt-file", cfg.SystemPromptFile)
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, cfg.Prompt)
	}

	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Droid session:
// `droid [--settings <path>] -r <agentSessionId>`. It re-applies the permission
// autonomy (resume otherwise reverts to the configured default) but not the
// prompt, which the session already carries. ok is false when the hook-derived
// native session id has not landed yet, so callers fall back to fresh launch
// behavior — mirroring the Codex and opencode adapters.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.droidBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 5)
	cmd = append(cmd, binary)
	settingsArgs, err := permissionSettingsArgs(cfg.Session.ID, cfg.Permissions)
	if err != nil {
		return nil, false, err
	}
	cmd = append(cmd, settingsArgs...)
	if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	} else if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "--append-system-prompt-file", cfg.SystemPromptFile)
	}
	cmd = append(cmd, "-r", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Droid hook-derived metadata. Metadata is intentionally
// nil: callers get the normalized fields directly, matching the Codex adapter.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// droidAutonomyLevel maps an AO permission mode onto Droid's
// sessionDefaultSettings.autonomyLevel (off|low|medium|high). The empty string
// means "no override" — defer to the user's own Droid settings — so the default
// mode emits no --settings flag and writes no file.
//
//	accept-edits       → low    (safe file operations)
//	auto               → medium (local dev operations)
//	bypass-permissions → high   (max interactive autonomy; Droid's interactive
//	                             TUI has no exec-style --skip-permissions-unsafe)
func droidAutonomyLevel(mode ports.PermissionMode) string {
	switch ports.NormalizePermissionMode(mode) {
	case ports.PermissionModeAcceptEdits:
		return "low"
	case ports.PermissionModeAuto:
		return "medium"
	case ports.PermissionModeBypassPermissions:
		return "high"
	default:
		return ""
	}
}

// permissionSettingsArgs renders a non-default permission mode as a
// `--settings <path>` argv pair, writing a process-scoped runtime settings file
// that overrides only sessionDefaultSettings.autonomyLevel. The default mode
// returns nil (no flag, no file) so Droid uses the user's own settings.
//
// Interactive `droid` exposes no per-launch permission flag (--auto and
// --skip-permissions-unsafe exist only on `droid exec`), so autonomy must be
// delivered through settings. The file is written under the OS temp dir, keyed
// by session id, rather than into the worktree so it never lands in a commit.
func permissionSettingsArgs(sessionID string, mode ports.PermissionMode) ([]string, error) {
	level := droidAutonomyLevel(mode)
	if level == "" {
		return nil, nil
	}

	blob, err := json.Marshal(map[string]any{
		"sessionDefaultSettings": map[string]any{"autonomyLevel": level},
	})
	if err != nil {
		return nil, fmt.Errorf("droid: encode runtime settings: %w", err)
	}

	path := runtimeSettingsPath(sessionID)
	if err := hookutil.AtomicWriteFile(path, append(blob, '\n'), 0o600); err != nil {
		return nil, fmt.Errorf("droid: write runtime settings: %w", err)
	}
	return []string{"--settings", path}, nil
}

// runtimeSettingsPath is the deterministic temp-dir path for a session's
// process-scoped runtime settings file. A stable name keyed by session id means
// relaunches overwrite rather than accumulate files.
func runtimeSettingsPath(sessionID string) string {
	name := sanitizeSessionID(sessionID)
	if name == "" {
		name = "default"
	}
	return filepath.Join(os.TempDir(), "ao-droid-"+name+"-settings.json")
}

// sanitizeSessionID keeps only filename-safe characters so the session id can
// be embedded in a temp file name without path traversal or separators.
func sanitizeSessionID(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

var droidBinarySpec = binaryutil.BinarySpec{
	Label:         "droid",
	Names:         []string{"droid"},
	WinNames:      []string{"droid.cmd", "droid.exe", "droid"},
	UnixPaths:     []string{"/usr/local/bin/droid", "/opt/homebrew/bin/droid"},
	UnixHomePaths: binaryutil.NodeManagedUnixHomePaths("droid", []string{".factory", "bin", "droid"}),
	NodeManaged:   true,
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "droid.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "droid.exe"}},
		{Base: binaryutil.WinHome, Parts: []string{".local", "bin", "droid.exe"}},
		{Base: binaryutil.WinHome, Parts: []string{".factory", "bin", "droid.exe"}},
	},
}

// ResolveDroidBinary returns the path to the droid binary, or a wrapped
// ports.ErrAgentBinaryNotFound when it is absent.
func ResolveDroidBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, droidBinarySpec)
}

func (p *Plugin) droidBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveDroidBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
