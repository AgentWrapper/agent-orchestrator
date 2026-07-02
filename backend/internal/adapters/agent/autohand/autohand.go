// Package autohand implements the Autohand Code agent adapter: launching new
// command-mode sessions, resuming native sessions by id, installing AO's
// lifecycle hooks into Autohand's config, and reading hook-derived session info.
//
// Autohand ("autohand") is an autonomous coding agent with a non-interactive
// command mode (`autohand -p <prompt>` / positional prompt), native session
// resume (`autohand resume <sessionId>`), and a native hook/lifecycle system
// whose events (session-start, stop, permission-request, ...) AO maps onto
// activity states. See hooks.go for hook installation and activity.go for the
// event→state mapping.
package autohand

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

const (
	adapterID = "autohand"

	autohandTitleMetadataKey   = "title"
	autohandSummaryMetadataKey = "summary"
)

// Plugin is the Autohand agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Autohand adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Autohand fires a pre-prompt hook under AO's
// launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Autohand",
		Description: "Run Autohand worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Autohand exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new Autohand command-mode session,
// scoping the run to the workspace, applying the approval-mode flags and optional
// system-prompt override, and passing the initial prompt as a positional argument
// after `--` so a prompt beginning with "-" is not read as a flag.
//
//	autohand [--path <workspace>] [<approval flags>] [--sys-prompt <value>] [-- <prompt>]
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.autohandBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendWorkspaceFlag(&cmd, cfg.WorkspacePath)
	appendApprovalFlags(&cmd, cfg.Permissions)

	// Autohand's --sys-prompt accepts either an inline string or a file path,
	// auto-detected by the CLI; prefer the file form when AO provides one.
	if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "--sys-prompt", cfg.SystemPromptFile)
	} else if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--sys-prompt", cfg.SystemPrompt)
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Autohand receives its prompt in the
// launch command itself.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Autohand
// session: `autohand resume [--path <workspace>] <sessionId>`. ok is false when
// the hook-derived native session id has not landed yet, so callers can fall
// back to fresh launch behavior. Autohand's resume sub-command does not accept
// approval flags, so none are appended here.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.autohandBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 5)
	cmd = append(cmd, binary, "resume")
	appendWorkspaceFlag(&cmd, cfg.Session.WorkspacePath)
	cmd = append(cmd, agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Autohand hook-derived metadata. Metadata is intentionally
// nil: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[autohandTitleMetadataKey],
		Summary:        session.Metadata[autohandSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// appendWorkspaceFlag scopes the run to the given workspace path via --path.
func appendWorkspaceFlag(cmd *[]string, workspacePath string) {
	if strings.TrimSpace(workspacePath) != "" {
		*cmd = append(*cmd, "--path", workspacePath)
	}
}

// appendApprovalFlags maps AO's four permission modes onto Autohand's approval
// flags. Default emits no flag so Autohand resolves its starting mode from the
// user's own config (permissions.mode). Autohand has no distinct "accept-edits"
// mode, so it maps to --yes (auto-confirm risky actions) — the least-privileged
// non-interactive option — while auto/bypass map to --unrestricted.
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's Autohand config/default behavior.
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--yes")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--unrestricted")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--unrestricted")
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

// ResolveAutohandBinary returns the path to the autohand binary on this machine,
// searching PATH then a handful of well-known install locations (Homebrew, the
// official ~/.local/bin installer, npm global). Returns "autohand" as a
// last-ditch fallback so callers see a clear "command not found" rather than an
// empty argv.
func ResolveAutohandBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"autohand.cmd", "autohand.exe", "autohand"} {
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
				filepath.Join(appData, "npm", "autohand.cmd"),
				filepath.Join(appData, "npm", "autohand.exe"),
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".local", "bin", "autohand.exe"))
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				return candidate, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		return "", fmt.Errorf("autohand: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("autohand"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/autohand",
		"/opt/homebrew/bin/autohand",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "autohand"),
			filepath.Join(home, ".npm", "bin", "autohand"),
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

	return "", fmt.Errorf("autohand: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) autohandBinary(ctx context.Context) (string, error) {
	// Honor cancellation even on the cached path, where ResolveAutohandBinary
	// (which has its own ctx.Err() guard) is never reached.
	if err := ctx.Err(); err != nil {
		return "", err
	}

	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveAutohandBinary(ctx)
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
