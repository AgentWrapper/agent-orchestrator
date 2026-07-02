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
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// Normalized session-metadata keys the hooks persist into the AO session
	// store and SessionInfo reads back. Shared vocabulary with the Codex, Grok,
	// and opencode adapters so the dashboard treats every agent uniformly.
	droidTitleMetadataKey   = "title"
	droidSummaryMetadataKey = "summary"
)

// Plugin is the Droid agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Droid adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Droid fires a user-prompt-submit hook under AO's
// launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

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

// GetConfigSpec reports no agent-specific config keys yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
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

	if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "--append-system-prompt-file", cfg.SystemPromptFile)
	} else if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Droid receives its prompt in the launch
// command itself (the positional prompt argument).
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
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
	cmd = append(cmd, "-r", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Droid hook-derived metadata. Metadata is intentionally
// nil: callers get the normalized fields directly, matching the Codex adapter.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[droidTitleMetadataKey],
		Summary:        session.Metadata[droidSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
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
	switch normalizePermissionMode(mode) {
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

// ResolveDroidBinary finds the `droid` binary (Factory Droid CLI), searching
// PATH then a handful of well-known install locations. Returns "droid" as a
// last-ditch fallback so callers see a clear "command not found" rather than an
// empty argv.
func ResolveDroidBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"droid.cmd", "droid.exe", "droid"} {
			if path, err := exec.LookPath(name); err == nil && path != "" {
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}
		candidates := []string{}
		if appData := os.Getenv("APPDATA"); appData != "" {
			candidates = append(candidates,
				filepath.Join(appData, "npm", "droid.cmd"),
				filepath.Join(appData, "npm", "droid.exe"),
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates,
				filepath.Join(home, ".local", "bin", "droid.exe"),
				filepath.Join(home, ".factory", "bin", "droid.exe"),
			)
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				return candidate, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}
		return "", fmt.Errorf("droid: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("droid"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/droid",
		"/opt/homebrew/bin/droid",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "droid"),
			filepath.Join(home, ".factory", "bin", "droid"),
		)
	}

	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate, nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("droid: %w", ports.ErrAgentBinaryNotFound)
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

func normalizePermissionMode(mode ports.PermissionMode) ports.PermissionMode {
	switch mode {
	case ports.PermissionModeDefault,
		ports.PermissionModeAcceptEdits,
		ports.PermissionModeAuto,
		ports.PermissionModeBypassPermissions:
		return mode
	default:
		// Empty or unrecognized: defer to Droid's own settings (no flag).
		return ports.PermissionModeDefault
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
