// Package devin implements the Devin ("Devin for Terminal", Cognition) agent
// adapter.
//
// Devin for Terminal (binary "devin") is Cognition's terminal coding agent. It
// has a documented Claude Code compatibility layer: it imports `.claude/`
// configuration (commands, subagents, and Claude Code lifecycle hooks), storing
// the converted hooks in `.devin/hooks.v1.json`. Because of this, AO reuses the
// Claude Code hook installer (which writes .claude/settings.local.json with AO
// hook commands) and Devin picks them up via its compat layer. This makes Devin
// a Tier B (Claude-compat) adapter, mirroring the grok adapter.
//
// Launch starts interactive Devin. Prompted worker tasks are delivered after
// startup through the runtime pane instead of `-p <prompt>` because Devin's
// print mode is not usable for normal implementation work: it cannot request
// interactive write/edit approvals and may render as a blank session. Permission
// handling uses `--permission-mode`, whose valid values are `normal` (aliases:
// auto) and `dangerous` (aliases: yolo, bypass). AO's four permission modes are
// mapped onto these two: Default emits no flag (defer to the user's
// ~/.config/devin/config.json), AcceptEdits/Auto map to `auto`, and
// BypassPermissions maps to `dangerous`.
//
// Restore prefers the hook-captured native session id via `-r <id>`. Devin
// session ids are listed by `devin list --format json`; AO captures the native
// id through the Claude-compat hook payloads (SessionStart) into session
// metadata, the same path grok uses.
package devin

import (
	"context"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var devinBinarySpec = binaryutil.BinarySpec{
	Label:         "devin",
	Names:         []string{"devin"},
	WinNames:      []string{"devin.cmd", "devin.exe", "devin"},
	UnixPaths:     []string{"/usr/local/bin/devin", "/opt/homebrew/bin/devin"},
	UnixHomePaths: [][]string{{".devin", "bin", "devin"}, {".local", "bin", "devin"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinHome, Parts: []string{".devin", "bin", "devin.exe"}},
	},
}

// Plugin is the Devin for Terminal agent adapter.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Devin adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "devin",
		Name:        "Devin",
		Description: "Run Cognition Devin for Terminal worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds `devin [--permission-mode <mode>]`.
// Prompt is delivered after the interactive session starts.
//
// Permission values come from `devin --permission-mode -h`:
// `normal` (alias auto) and `dangerous` (aliases yolo, bypass). Default omits
// the flag so Devin uses its config (default mode is auto/normal).
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.devinBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendApprovalFlags(&cmd, cfg.Permissions)

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Devin should receive prompted tasks
// after the interactive terminal session has started. Avoiding `devin -p`
// keeps worker sessions capable of implementation work and permission prompts.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, _ ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryAfterStart, nil
}

// GetAgentHooks reuses the Claude Code hook installer because Devin for Terminal
// has a documented Claude Code compatibility layer.
//
// Official docs (https://docs.devin.ai/cli, Configuration Import / Extensibility):
// Devin reads configuration from `.claude/` including "Commands, custom
// subagents, hooks"; its "Lifecycle hooks (Claude Code compatible)" are stored
// in `.devin/hooks.v1.json`. The binary itself ships a
// `config-importers/.../claude` + `agent-ext/hooks/importers/claude` layer that
// converts Claude hooks (SessionStart, UserPromptSubmit, Stop, PermissionRequest,
// SessionEnd, ...) on load.
//
// This means Devin picks up the .claude/settings.local.json (and the AO hook
// commands we install there) in the worktree. The installed commands are
// "ao hooks claude-code <evt>", so the existing CLI hook dispatcher routes them
// to claude derive logic (Devin is grouped with claude-code in cli/hooks.go).
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return (&claudecode.Plugin{}).GetAgentHooks(ctx, cfg)
}

// GetRestoreCommand builds `devin [--permission-mode <mode>] -r <agentSessionId>`
// when we have a hook-captured native id. ok=false otherwise (fall back to fresh
// launch in the manager).
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.devinBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 5)
	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "-r", agentSessionID)
	return cmd, true, nil
}

// SessionInfo reads hook-derived metadata. Since we delegate hook install to
// claude hooks (via compat), the keys in the metadata map are the claude ones
// ("title", "summary", "agentSessionId"). We surface them under the normalized
// SessionInfo.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// ResolveDevinBinary finds the `devin` binary (Cognition Devin for Terminal CLI).
func ResolveDevinBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, devinBinarySpec)
}

func (p *Plugin) devinBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveDevinBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// appendApprovalFlags maps AO's four permission modes onto Devin's two native
// permission values (`auto`/normal and `dangerous`/bypass), per
// `devin --permission-mode -h`.
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to ~/.config/devin/config.json (default mode is auto).
	case ports.PermissionModeAcceptEdits:
		// Devin has no dedicated accept-edits flag; auto prompts for writes,
		// which is the safest non-default mapping.
		*cmd = append(*cmd, "--permission-mode", "auto")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--permission-mode", "auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--permission-mode", "dangerous")
	}
}
