// Package opencode implements the opencode (sst/opencode) agent adapter:
// launching new TUI sessions, resuming sessions by native id, installing a
// workspace-local activity plugin, and reading plugin-derived session info.
//
// opencode differs from Claude Code and Codex in two ways AO has to bridge:
//   - It has no native command-hook config (no settings.local.json / hooks.json
//     equivalent). Its only lifecycle-extensibility surface is a JS/TS plugin
//     loaded from .opencode/plugins/, so GetAgentHooks installs an AO-owned
//     plugin file (see hooks.go) instead of merging JSON.
//   - Its CLI exposes only one approval flag (--dangerously-skip-permissions)
//     and no system-prompt flag, so the graduated permission modes and the
//     system prompt are deferred to opencode's own config.
//
// AO-managed sessions derive native session identity and display metadata from
// the opencode plugin's reported events, mirroring the Codex adapter.
package opencode

import (
	"context"
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
	// `ao spawn --agent`. It matches domain.HarnessOpenCode.
	adapterID = "opencode"

	// Normalized session-metadata keys the opencode plugin persists into the AO
	// session store and SessionInfo reads back. Shared vocabulary with the Codex
	// and Claude Code adapters so the dashboard treats every agent uniformly.
	opencodeAgentSessionIDMetadataKey = "agentSessionId"
	opencodeTitleMetadataKey          = "title"
	opencodeSummaryMetadataKey        = "summary"
)

// Plugin is the opencode agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register opencode adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals OpenCode fires a user-prompt-submit hook (via its
// TS plugin) under AO's launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

// EmitsBlockedActivity is false: this harness installs no permission/approval
// hook, so it can never report ActivityBlocked. confirmActive must not nudge
// it (an Enter could answer a pending decision it cannot signal). See
// ports.ActivitySignaler.
func (p *Plugin) EmitsBlockedActivity() bool { return false }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "opencode",
		Description: "Run opencode worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. opencode exposes none
// yet: model and agent selection are read from opencode's own config
// (opencode.json / ~/.config/opencode), exactly as a normal launch.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new interactive opencode session.
// Shape:
//
//	opencode [--dangerously-skip-permissions] [--prompt <prompt>]
//
// The session runs in the worktree (cwd is set by the runtime, as for Claude
// Code and Codex). opencode has no CLI flag to set a system prompt, so
// cfg.SystemPrompt / SystemPromptFile are intentionally ignored here — opencode
// resolves instructions from its own config and AGENTS.md rules. The initial
// task prompt is delivered via --prompt (its argument, so a leading "-" is not
// read as a flag).
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.opencodeBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendPermissionFlags(&cmd, cfg.Permissions)
	if cfg.Prompt != "" {
		cmd = append(cmd, "--prompt", cfg.Prompt)
	}
	return cmd, nil
}

// GetPromptDeliveryStrategy reports that opencode receives its prompt in the
// launch command itself (via --prompt).
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing opencode
// session: `opencode [--dangerously-skip-permissions] --session <agentSessionId>`.
// It re-applies the permission flag (resume otherwise reverts to the configured
// default) but not the prompt, which the session already carries. ok is false
// when the plugin-derived native session id has not landed yet, so callers fall
// back to fresh launch behavior — mirroring the Codex adapter.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[opencodeAgentSessionIDMetadataKey])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.opencodeBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 4)
	cmd = append(cmd, binary)
	appendPermissionFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--session", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces opencode plugin-derived metadata. Metadata is
// intentionally nil for opencode: callers get the normalized fields directly,
// matching the Codex adapter.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[opencodeAgentSessionIDMetadataKey],
		Title:          session.Metadata[opencodeTitleMetadataKey],
		Summary:        session.Metadata[opencodeSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// appendPermissionFlags maps AO's permission modes onto opencode's single
// approval flag. opencode exposes only --dangerously-skip-permissions (no
// graduated accept-edits/auto modes), so:
//   - bypass-permissions → --dangerously-skip-permissions
//   - default / accept-edits / auto → no flag. opencode resolves approvals from
//     its own `permission` config exactly as a normal launch.
func appendPermissionFlags(cmd *[]string, permissions ports.PermissionMode) {
	if normalizePermissionMode(permissions) == ports.PermissionModeBypassPermissions {
		*cmd = append(*cmd, "--dangerously-skip-permissions")
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
		// Empty or unrecognized: defer to opencode's own config (no flag).
		return ports.PermissionModeDefault
	}
}

// ResolveOpenCodeBinary returns the path to the opencode binary on this machine,
// searching PATH then a handful of well-known install locations (the install
// script's ~/.opencode/bin, Homebrew, npm global). Returns "opencode" as a
// last-ditch fallback so callers see a clear "command not found" rather than an
// empty argv.
func ResolveOpenCodeBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"opencode.cmd", "opencode.exe", "opencode"} {
			if path, err := exec.LookPath(name); err == nil && path != "" {
				return path, nil
			}
		}
		candidates := []string{}
		if appData := os.Getenv("APPDATA"); appData != "" {
			candidates = append(candidates,
				filepath.Join(appData, "npm", "opencode.cmd"),
				filepath.Join(appData, "npm", "opencode.exe"),
			)
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				return candidate, nil
			}
		}
		return "opencode", nil
	}

	if path, err := exec.LookPath("opencode"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/opencode",
		"/opt/homebrew/bin/opencode",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".opencode", "bin", "opencode"),
			filepath.Join(home, ".npm", "bin", "opencode"),
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

	return "opencode", nil
}

func (p *Plugin) opencodeBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveOpenCodeBinary(ctx)
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
