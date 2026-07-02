// Package grok implements the Grok Build (xAI) agent adapter.
//
// Grok Build is xAI's terminal coding agent (binary "grok"). It supports
// Claude Code compatibility for hooks, skills, etc., so we reuse the claude
// hook installation (which writes .claude/settings.local.json with AO
// hook commands). Grok will pick them up via its compat layer.
//
// Launch uses `-p <prompt>` for the initial task (in-command delivery).
// Permission bypass uses `--always-approve`. We also pass `--no-auto-update`
// for headless/scripted use (parity with Codex no-update).
// Restore prefers the hook-captured native session id via `-r <id>`.
//
// SessionInfo and title/summary flow through the shared claude hook path
// (when the hook handlers are extended to persist them).
package grok

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
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Plugin is the Grok Build agent adapter.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Grok adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity: Grok delegates hooks to claude-code, which fires
// user-prompt-submit. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "grok",
		Name:        "Grok Build",
		Description: "Run xAI Grok Build worker sessions.",
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

// GetLaunchCommand builds `grok --no-auto-update [--permission-mode <mode>] -p <prompt>`.
// Prompt is delivered via -p (in command).
//
// Uses --permission-mode (acceptEdits / auto / bypassPermissions) to match
// `grok -h` output. Default omits the flag so Grok uses its config.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.grokBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary, "--no-auto-update"}
	appendApprovalFlags(&cmd, cfg.Permissions)

	if cfg.Prompt != "" {
		cmd = append(cmd, "-p", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that the prompt is delivered in the launch command.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetAgentHooks reuses the Claude Code hook installer because Grok Build
// has a full Claude Code compatibility layer.
//
// Official docs (https://docs.x.ai/build/features/skills-plugins-marketplaces#claude-code-compatibility:~:text=tasks%20in%20parallel.-,Claude%20Code%20compatibility,-Grok%20is%20fully):
//
//	"Grok is fully compatible with Claude Code with zero configuration needed.
//	 Grok automatically reads Claude Code ... hooks ... alongside .grok/."
//
// This means Grok will pick up the .claude/settings.local.json (and the
// AO hook commands we install there) in the worktree. The hook payloads for
// SessionStart / UserPromptSubmit / Stop etc. are compatible, so we get
// title/summary/agentSessionId + activity for free without a separate native
// .grok/hooks/ implementation or code duplication.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Delegate; the installed commands will be "ao hooks claude-code <evt>"
	// so the existing CLI hook dispatcher routes them to claude derive logic.
	// This works because of Grok's documented zero-config Claude compat.
	return (&claudecode.Plugin{}).GetAgentHooks(ctx, cfg)
}

// UninstallHooks removes the Claude Code-compatible AO hooks Grok uses.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return (&claudecode.Plugin{}).UninstallHooks(ctx, workspacePath)
}

// AreHooksInstalled reports whether the delegated Claude Code-compatible AO
// hooks are present for this Grok workspace.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return (&claudecode.Plugin{}).AreHooksInstalled(ctx, workspacePath)
}

// GetRestoreCommand resumes a prior grok session by its captured id, building
// `grok --no-auto-update [--permission-mode <mode>] -r <agentSessionId>`
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

	binary, err := p.grokBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 4)
	cmd = append(cmd, binary, "--no-auto-update")
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "-r", agentSessionID)
	return cmd, true, nil
}

// SessionInfo reads hook-derived metadata. Since we delegate hook install to
// claude hooks (via compat), the keys in the metadata map are the claude ones
// ("title", "summary", "agentSessionId"). We surface them under the normalized
// SessionInfo; grok-specific aliases are not needed.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	// The keys written by claude hooks (which we install for grok too).
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[ports.MetadataKeyTitle],
		Summary:        session.Metadata[ports.MetadataKeySummary],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// ResolveGrokBinary finds the `grok` binary (xAI Grok Build CLI).
func ResolveGrokBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"grok.cmd", "grok.exe", "grok"} {
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
				filepath.Join(appData, "npm", "grok.cmd"),
				filepath.Join(appData, "npm", "grok.exe"),
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates,
				filepath.Join(home, ".grok", "bin", "grok.exe"),
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
		return "", fmt.Errorf("grok: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("grok"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/grok",
		"/opt/homebrew/bin/grok",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".grok", "bin", "grok"),
			filepath.Join(home, ".local", "bin", "grok"),
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

	return "", fmt.Errorf("grok: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) grokBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveGrokBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's ~/.grok/config.toml (or default behavior).
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--permission-mode", "acceptEdits")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--permission-mode", "auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--permission-mode", "bypassPermissions")
	}
}

func normalizePermissionMode(mode ports.PermissionMode) ports.PermissionMode {
	switch mode {
	case ports.PermissionModeDefault,
		ports.PermissionModeAcceptEdits,
		ports.PermissionModeAuto,
		ports.PermissionModeBypassPermissions:
		return mode
	default:
		return ports.PermissionModeDefault
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
