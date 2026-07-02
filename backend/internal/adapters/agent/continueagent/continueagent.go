// Package continueagent implements the Continue CLI agent adapter.
//
// Continue (https://docs.continue.dev/guides/cli) is Continue's terminal coding
// agent. Its binary is "cn" (npm package @continuedev/cli) and the AO harness /
// manifest id is the string "continue". The Go package and directory are named
// "continueagent" because "continue" is a reserved keyword.
//
// Tier B (Claude Code-compatible hooks): the Continue CLI natively reads Claude
// Code hook settings (.claude/settings.json and .claude/settings.local.json) and
// dispatches Claude-format hook events (SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse, Stop, Notification) with the standard hook payload
// (session_id, hook_event_name, hookSpecificOutput, permissionDecision,
// additionalContext). So we reuse the claudecode hook installer and route hook
// callbacks through the existing "ao hooks claude-code <evt>" dispatcher — no
// Continue-specific native hook config or activity deriver is needed.
//
// Launch is headless via `cn --print [--auto|--readonly] <prompt>`; the prompt
// is the positional argument (in-command delivery). Restore continues a specific
// native session by id with `cn --fork <sessionId>` (Continue's `--resume` only
// continues the *last* session, so it cannot target a particular AO session).
package continueagent

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

// adapterID is the AO harness / manifest id. It is the string "continue"
// (NOT the Go package name "continueagent").
const adapterID = "continue"

// Plugin is the Continue CLI agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Continue adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity: Continue delegates hooks to claude-code, which fires
// user-prompt-submit. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description. ID is "continue".
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Continue",
		Description: "Run Continue CLI worker sessions.",
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

// GetLaunchCommand builds `cn --print [--auto|--readonly] <prompt>`.
//
// `--print` runs Continue in non-interactive (headless) mode. The prompt is the
// positional argument and is delivered in-command. Permission flags map AO's 4
// modes onto Continue's two booleans (--auto / --readonly); Default and
// AcceptEdits emit no flag so Continue resolves behavior from the user's config.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.continueBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary, "--print"}
	appendApprovalFlags(&cmd, cfg.Permissions)

	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
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

// GetAgentHooks reuses the Claude Code hook installer because the Continue CLI
// natively reads Claude Code hook settings.
//
// The installed commands are "ao hooks claude-code <evt>", so the existing CLI
// hook dispatcher routes them to the claude derive logic. The Continue CLI reads
// .claude/settings.local.json from the worktree and fires Claude-format events
// (SessionStart / UserPromptSubmit / Stop / Notification), giving AO
// title/summary/agentSessionId + activity for free without a Continue-specific
// hook implementation or code duplication.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return (&claudecode.Plugin{}).GetAgentHooks(ctx, cfg)
}

// GetRestoreCommand builds `cn --print [--auto|--readonly] --fork <agentSessionId>`
// when a hook-captured native session id is available. ok=false otherwise (the
// manager falls back to a fresh launch). `--fork <id>` continues a specific
// session by id; Continue's `--resume` only continues the last session and so
// cannot target a particular AO session.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.continueBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 4)
	cmd = append(cmd, binary, "--print")
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--fork", agentSessionID)
	return cmd, true, nil
}

// SessionInfo reads hook-derived metadata. Since hook install is delegated to
// the claude hooks (via Continue's compat layer), the metadata keys are the
// claude ones ("title", "summary", "agentSessionId").
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
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

// ResolveContinueBinary finds the `cn` binary (Continue CLI), searching PATH then
// common npm/global install locations. It returns "cn" as a last resort so
// callers get the shell's normal command-not-found behavior if Continue is
// absent.
func ResolveContinueBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"cn.cmd", "cn.exe", "cn"} {
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
				filepath.Join(appData, "npm", "cn.cmd"),
				filepath.Join(appData, "npm", "cn.exe"),
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
		return "", fmt.Errorf("cn: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("cn"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/cn",
		"/opt/homebrew/bin/cn",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".npm-global", "bin", "cn"),
			filepath.Join(home, ".local", "bin", "cn"),
			filepath.Join(home, ".npm", "bin", "cn"),
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

	return "", fmt.Errorf("cn: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) continueBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveContinueBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// appendApprovalFlags maps AO's 4 permission modes onto Continue's two boolean
// flags. Continue exposes only `--readonly` (plan mode, read-only tools) and
// `--auto` (all tools allowed); there is no separate yolo/bypass beyond --auto,
// and the two flags are mutually exclusive. Default and AcceptEdits emit no flag
// so Continue defers to the user's own config / default behavior.
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's Continue config / default behavior.
	case ports.PermissionModeAcceptEdits:
		// Continue has no granular "accept edits only" mode; defer to config.
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--auto")
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
