// Package qwen implements the Qwen Code agent adapter: launching new sessions,
// resuming hook-tracked sessions, installing workspace-local native hooks, and
// reading hook-derived session info.
//
// Qwen Code (github.com/QwenLM/qwen-code) is a fork of Google's gemini-cli, so
// it inherits gemini-cli-shaped flags: `-p/--prompt` (or a positional prompt)
// for the headless one-shot prompt, `--approval-mode {plan,default,auto-edit,
// auto,yolo}` for permissions, and `-r/--resume <id>` to continue a specific
// session. It also has a native Claude-Code-shaped hook system configured in
// `.qwen/settings.json` (top-level "hooks" key, event arrays of matcher groups
// with command hooks), and emits a `session_id` in every hook payload — so AO
// captures native session identity and activity from those hooks rather than
// from transcript/cache scans.
package qwen

import (
	"context"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Plugin is the Qwen Code agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Qwen Code adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "qwen",
		Name:        "Qwen Code",
		Description: "Run Qwen Code worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a new Qwen Code session: the
// approval-mode flag, optional system-prompt instructions, and the initial
// prompt (passed via `-p` so a leading "-" is not read as a flag). Prompt is
// delivered in-command.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.qwenBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendApprovalFlags(&cmd, cfg.Permissions)

	if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, "-p", cfg.Prompt)
	}

	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Qwen Code
// session: `qwen [--approval-mode <mode>] -r <agentSessionId>`. ok is false when
// the hook-derived native session id has not landed yet, so callers can fall
// back to fresh launch behavior. Note: ports.RestoreConfig carries no Prompt.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.qwenBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 6)
	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "-r", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Qwen Code hook-derived metadata. Metadata is
// intentionally nil for Qwen: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

var qwenBinarySpec = binaryutil.BinarySpec{
	Label:         "qwen",
	Names:         []string{"qwen"},
	WinNames:      []string{"qwen.cmd", "qwen.exe", "qwen"},
	UnixPaths:     []string{"/usr/local/bin/qwen", "/opt/homebrew/bin/qwen"},
	UnixHomePaths: [][]string{{".npm-global", "bin", "qwen"}, {".npm", "bin", "qwen"}, {".local", "bin", "qwen"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "qwen.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "qwen.exe"}},
	},
}

// ResolveQwenBinary returns the path to the qwen binary, or a wrapped
// ports.ErrAgentBinaryNotFound when it is absent.
func ResolveQwenBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, qwenBinarySpec)
}

func (p *Plugin) qwenBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveQwenBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// appendApprovalFlags maps AO's four permission modes onto Qwen Code's
// `--approval-mode` choices (plan|default|auto-edit|auto|yolo). Default emits no
// flag so Qwen resolves its starting mode from the user's own config.
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's Qwen Code config/default behavior.
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--approval-mode", "auto-edit")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--approval-mode", "auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--approval-mode", "yolo")
	}
}
