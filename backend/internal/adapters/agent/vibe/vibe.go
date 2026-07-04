// Package vibe implements the Mistral Vibe agent adapter: launching new
// non-interactive Vibe sessions and resuming sessions when a native Vibe
// session id is known.
//
// Mistral Vibe (binary "vibe", https://github.com/mistralai/mistral-vibe) is a
// Python CLI installed via `uv tool install mistral-vibe`, pip, or its install
// script. AO drives it in programmatic/headless mode with `-p <prompt>`, which
// auto-approves tools, prints the final response, and exits. `--trust` skips
// the working-directory trust prompt for non-interactive automation, and
// `--output text` pins the human-readable output format.
//
// Permission modes map onto Vibe's builtin agent profiles via `--agent`:
// accept-edits ("auto-approves file edits only") and auto-approve
// ("auto-approves all tool executions"). PermissionModeDefault emits no flag so
// Vibe resolves its starting agent from the user's `default_agent` config.
//
// Vibe has no usable lifecycle-hook surface for AO activity: its only hook type
// is an experimental, off-by-default POST_AGENT_TURN hook with no
// session-start/user-prompt-submit/stop/permission-request taxonomy, and it is
// not Claude-Code compatible. Hook installation and SessionInfo are therefore
// intentionally no-ops (Tier C).
//
// Restore uses `--resume <session id>` (Vibe matches by partial/short id) when
// a native session id is available in metadata.
package vibe

import (
	"context"
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

const adapterID = "vibe"

// Plugin is the Mistral Vibe agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Mistral Vibe adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Mistral Vibe",
		Description: "Run Mistral Vibe worker sessions.",
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

// GetLaunchCommand builds the argv to start a new non-interactive Vibe session:
//
//	vibe --trust --output text [--workdir <path>] [--agent <profile>] -p <prompt>
//
// The prompt is delivered through `-p` (programmatic mode), so AO uses
// in-command delivery. `--trust` skips the trust prompt for automation and
// `--output text` pins the output format. `--workdir` is passed explicitly
// because Vibe validates its own working directory in addition to the process
// cwd AO sets through the runtime. Vibe exposes no CLI system-prompt flag
// (system prompts are config-driven), so SystemPrompt is not forwarded.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	binary, err := p.vibeBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary, "--trust", "--output", "text"}
	appendWorkdirFlag(&cmd, cfg.WorkspacePath)
	appendAgentFlags(&cmd, cfg.Permissions)
	if cfg.Prompt != "" {
		cmd = append(cmd, "-p", cfg.Prompt)
	}
	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Vibe receives its prompt in the launch
// command itself.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetAgentHooks is intentionally a no-op: Vibe has no usable lifecycle-hook
// surface for AO activity reporting (Tier C).
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	return ctx.Err()
}

// GetRestoreCommand rebuilds the argv that continues an existing Vibe session
// when a native session id is available in metadata. Without it, ok is false
// and callers fall back to fresh launch behavior.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.vibeBinary(ctx)
	if err != nil {
		return nil, false, err
	}
	cmd = make([]string, 0, 8)
	cmd = append(cmd, binary, "--trust", "--output", "text")
	appendWorkdirFlag(&cmd, cfg.Session.WorkspacePath)
	appendAgentFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--resume", agentSessionID)
	return cmd, true, nil
}

// SessionInfo is intentionally a no-op until Vibe can surface native session
// metadata to AO.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	return ports.SessionInfo{}, false, nil
}

func appendWorkdirFlag(cmd *[]string, workspacePath string) {
	if workspacePath != "" {
		*cmd = append(*cmd, "--workdir", workspacePath)
	}
}

// appendAgentFlags maps AO permission modes onto Vibe's builtin `--agent`
// profiles. PermissionModeDefault (and the empty mode) emit no flag so Vibe
// resolves its starting agent from the user's `default_agent` config.
func appendAgentFlags(cmd *[]string, mode ports.PermissionMode) {
	switch mode {
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--agent", "accept-edits")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--agent", "auto-approve")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--agent", "auto-approve")
	}
}

// ResolveVibeBinary finds the `vibe` binary, searching PATH then common install
// locations. It returns "vibe" as a last resort so callers get the shell's
// normal command-not-found behavior if Vibe is absent.
func ResolveVibeBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"vibe.exe", "vibe.cmd", "vibe"} {
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
				filepath.Join(appData, "Python", "Scripts", "vibe.exe"),
			)
		}
		if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
			candidates = append(candidates,
				filepath.Join(localAppData, "uv", "tools", "mistral-vibe", "Scripts", "vibe.exe"),
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
		return "", fmt.Errorf("vibe: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("vibe"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/vibe",
		"/opt/homebrew/bin/vibe",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "vibe"),
			filepath.Join(home, ".local", "share", "uv", "tools", "mistral-vibe", "bin", "vibe"),
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

	return "", fmt.Errorf("vibe: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) vibeBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveVibeBinary(ctx)
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
