// Package kilocode implements the Kilo Code CLI agent adapter: launching new
// TUI sessions, resuming sessions by native id, installing a workspace-local
// activity plugin, and reading plugin-derived session info.
//
// The Kilo Code CLI (binary "kilocode", also aliased "kilo"; npm package
// @kilocode/cli) is a fork of sst/opencode and shares its CLI surface and
// plugin runtime, so AO bridges it the same two ways it bridges opencode:
//   - It has no native command-hook config (no settings.local.json / hooks.json
//     equivalent). Its only lifecycle-extensibility surface is the @opencode-ai
//     plugin SDK loaded from a config dir's `{plugin,plugins}/*.{ts,js}` glob,
//     so GetAgentHooks installs an AO-owned plugin file (see hooks.go) into
//     .kilocode/plugins/ instead of merging JSON.
//   - Its interactive TUI exposes no permission flag (the --auto flag lives only
//     on `kilo run`, not the default TUI command AO launches) and no
//     system-prompt flag. AO's graduated permission modes are delivered via the
//     KILO_CONFIG_CONTENT env var, which Kilo deep-merges as the
//     highest-precedence inline config; the system prompt defers to Kilo's own
//     config.
//
// AO-managed sessions derive native session identity and display metadata from
// the Kilo plugin's reported events, mirroring the opencode and Codex adapters.
package kilocode

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
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// adapterID is the registry id and the value users pass to
	// `ao spawn --agent`. It matches domain.HarnessKilocode.
	adapterID = "kilocode"

	// Normalized session-metadata keys the Kilo plugin persists into the AO
	// session store and SessionInfo reads back. Shared vocabulary with the Codex
	// and opencode adapters so the dashboard treats every agent uniformly. The
	// agent-session-id key is the shared ports.MetadataKeyAgentSessionID.
	kilocodeTitleMetadataKey   = "title"
	kilocodeSummaryMetadataKey = "summary"
)

// Plugin is the Kilo Code agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Kilo Code adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Kilo Code fires a user-prompt-submit hook (via its
// TS plugin) under AO's launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Kilo Code",
		Description: "Run Kilo Code worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Kilo Code exposes none
// yet: model and agent selection are read from Kilo's own config
// (kilo.json / ~/.config/kilo), exactly as a normal launch.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new interactive Kilo Code session.
// Shape:
//
//	[env KILO_CONFIG_CONTENT=<json>] kilocode [--prompt <prompt>]
//
// The session runs in the worktree (cwd is set by the runtime, as for opencode
// and Codex). Kilo Code has no CLI flag to set a system prompt, so
// cfg.SystemPrompt / SystemPromptFile are intentionally ignored here — Kilo
// resolves instructions from its own config and AGENTS.md rules. The initial
// task prompt is delivered via --prompt (its argument, so a leading "-" is not
// read as a flag). Non-default permission modes prepend a KILO_CONFIG_CONTENT
// env assignment rather than a flag (see kilocodePermissionEnvPrefix).
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.kilocodeBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = append(kilocodePermissionEnvPrefix(cfg.Permissions), binary)
	if cfg.Prompt != "" {
		cmd = append(cmd, "--prompt", cfg.Prompt)
	}
	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Kilo Code receives its prompt in the
// launch command itself (via --prompt).
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Kilo Code
// session: `[env KILO_CONFIG_CONTENT=<json>] kilocode --session <agentSessionId>`.
// It re-applies the permission env (resume otherwise reverts to the configured
// default) but not the prompt, which the session already carries. ok is false
// when the plugin-derived native session id has not landed yet, so callers fall
// back to fresh launch behavior — mirroring the opencode adapter.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.kilocodeBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = append(kilocodePermissionEnvPrefix(cfg.Permissions), binary, "--session", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Kilo plugin-derived metadata. Metadata is intentionally
// nil for Kilo Code: callers get the normalized fields directly, matching the
// opencode and Codex adapters.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[kilocodeTitleMetadataKey],
		Summary:        session.Metadata[kilocodeSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// kilocodePermissionEnvVar is the env var Kilo deep-merges as the
// highest-precedence inline config (`KILO_CONFIG_CONTENT`, see the CLI's config
// precedence: global -> KILO_CONFIG -> ./kilo.json -> .kilo/kilo.json ->
// KILO_CONFIG_CONTENT -> managed; later wins). It is the permission-control
// surface the interactive TUI honors: the --auto flag exists solely on
// `kilo run`, not on the default TUI command AO launches, so passing any
// permission flag would make Kilo reject the argv and the session fail to launch.
const kilocodePermissionEnvVar = "KILO_CONFIG_CONTENT"

// kilocodePermissionConfig maps an AO permission mode onto Kilo's permission
// config (tool -> action, values "ask"/"allow"/"deny", verified via
// `kilocode config check`). Tools left unset fall back to Kilo's own default
// action ("ask"), so each mode only names the tools it relaxes:
//   - default            → nil: no env; Kilo's config decides every prompt.
//   - accept-edits       → edits ("write"/"edit"/"patch" gate on the "edit"
//     key) auto-approved; bash and everything else still prompt.
//   - auto               → edits + bash auto-approved; network/other still prompt.
//     Kilo has no classifier/reviewer gate (unlike Claude Code's "auto"), so
//     this is the closest analog its flat allow/ask/deny config can express.
//   - bypass-permissions → "*" wildcard-allows every tool: nothing prompts.
func kilocodePermissionConfig(mode ports.PermissionMode) map[string]string {
	switch normalizePermissionMode(mode) {
	case ports.PermissionModeAcceptEdits:
		return map[string]string{"edit": "allow"}
	case ports.PermissionModeAuto:
		return map[string]string{"edit": "allow", "bash": "allow"}
	case ports.PermissionModeBypassPermissions:
		return map[string]string{"*": "allow"}
	default:
		return nil
	}
}

// kilocodePermissionEnvPrefix renders mode's permission config as an
// `env KILO_CONFIG_CONTENT=<json>` argv prefix, or nil for the default mode.
//
// The var must reach Kilo as a process env var, not an argv flag. The runtime
// runs the argv through a shell, which execs `env`, which sets the var and execs
// kilocode. A bare `KILO_CONFIG_CONTENT=...` argv element would not work: the
// runtime shell-quotes every element, and a quoted token is run as a command
// rather than read as an assignment — hence the explicit `env` wrapper.
// POSIX-only, which matches the tmux runtime.
func kilocodePermissionEnvPrefix(mode ports.PermissionMode) []string {
	config := kilocodePermissionConfig(mode)
	if len(config) == 0 {
		return nil
	}
	// The inline config is the JSON object {"permission": {<tool>: <action>}}.
	// Marshaling a map[string]string never errors and emits keys in sorted order,
	// so the prefix is deterministic for tests and reproducible across launches.
	blob, err := json.Marshal(map[string]map[string]string{"permission": config})
	if err != nil {
		// Should never happen for map[string]map[string]string, but a silent
		// empty KILO_CONFIG_CONTENT would silently launch with default Kilo
		// permissions regardless of the requested mode — drop the prefix
		// entirely so the caller's mode choice can't be misrepresented.
		return nil
	}
	return []string{"env", kilocodePermissionEnvVar + "=" + string(blob)}
}

func normalizePermissionMode(mode ports.PermissionMode) ports.PermissionMode {
	switch mode {
	case ports.PermissionModeDefault,
		ports.PermissionModeAcceptEdits,
		ports.PermissionModeAuto,
		ports.PermissionModeBypassPermissions:
		return mode
	default:
		// Empty or unrecognized: defer to Kilo's own config (no flag).
		return ports.PermissionModeDefault
	}
}

// ResolveKilocodeBinary returns the path to the kilocode binary on this machine,
// searching PATH then a handful of well-known install locations (npm global
// bin, Homebrew). Returns "kilocode" as a last-ditch fallback so callers see a
// clear "command not found" rather than an empty argv.
func ResolveKilocodeBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"kilocode.cmd", "kilocode.exe", "kilocode"} {
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
				filepath.Join(appData, "npm", "kilocode.cmd"),
				filepath.Join(appData, "npm", "kilocode.exe"),
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
		return "", fmt.Errorf("kilocode: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("kilocode"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/kilocode",
		"/opt/homebrew/bin/kilocode",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".npm-global", "bin", "kilocode"),
			filepath.Join(home, ".npm", "bin", "kilocode"),
			filepath.Join(home, ".local", "bin", "kilocode"),
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

	return "", fmt.Errorf("kilocode: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) kilocodeBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveKilocodeBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
