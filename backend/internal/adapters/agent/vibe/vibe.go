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
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "vibe"

// Plugin is the Mistral Vibe agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
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

// appendWorkdirFlag adds Vibe's explicit `--workdir` flag. Vibe validates its
// own working directory in addition to the process cwd AO sets.
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

var vibeBinarySpec = binaryutil.BinarySpec{
	Label:         "vibe",
	Names:         []string{"vibe"},
	WinNames:      []string{"vibe.exe", "vibe.cmd", "vibe"},
	UnixPaths:     []string{"/usr/local/bin/vibe", "/opt/homebrew/bin/vibe"},
	UnixHomePaths: [][]string{{".local", "bin", "vibe"}, {".local", "share", "uv", "tools", "mistral-vibe", "bin", "vibe"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"Python", "Scripts", "vibe.exe"}},
		{Base: binaryutil.WinLocalAppData, Parts: []string{"uv", "tools", "mistral-vibe", "Scripts", "vibe.exe"}},
	},
}

// ResolveVibeBinary finds the `vibe` binary, searching PATH then common install
// locations. It returns a wrapped ports.ErrAgentBinaryNotFound when Vibe is absent.
func ResolveVibeBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, vibeBinarySpec)
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
