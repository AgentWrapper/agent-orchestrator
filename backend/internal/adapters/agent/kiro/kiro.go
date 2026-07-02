// Package kiro implements the Kiro (AWS) agent adapter: launching new headless
// sessions, resuming hook-tracked sessions, installing workspace-local hooks,
// and reading hook-derived session info.
//
// Kiro is AWS's agentic coding assistant. Its terminal CLI ships as the
// `kiro-cli` binary and exposes a non-interactive ("headless") mode via
// `kiro-cli chat --no-interactive "<prompt>"`, suitable for AO-driven worker
// sessions. See https://kiro.dev/docs/cli/headless/ and
// https://kiro.dev/docs/cli/reference/cli-commands/.
//
// Launch delivers the initial prompt as a positional argument after `--` so a
// leading "-" is not parsed as a flag. Permission/approval modes map onto
// Kiro's tool-trust flags (`--trust-all-tools`, `--trust-tools=<categories>`).
// Restore uses `kiro-cli chat --resume-id <UUID>` with the native session id
// captured from a Kiro hook payload.
//
// AO-managed sessions derive native session identity and display metadata from
// Kiro's native hooks (see hooks.go / activity.go) rather than transcript scans.
package kiro

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
	kiroTitleMetadataKey   = "title"
	kiroSummaryMetadataKey = "summary"
)

// Plugin is the Kiro agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Kiro adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Kiro fires a userPromptSubmit hook under AO's
// launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "kiro",
		Name:        "Kiro",
		Description: "Run Kiro (AWS) worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Kiro exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new headless Kiro session:
// `kiro-cli chat --no-interactive [trust flags] -- <prompt>`.
//
// The prompt is passed as a positional argument after `--` so a leading "-" is
// not read as a flag. Kiro's --no-interactive mode requires a prompt argument.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.kiroBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary, "chat", "--no-interactive"}
	appendApprovalFlags(&cmd, cfg.Permissions)

	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Kiro receives its prompt in the launch
// command itself.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Kiro session:
// `kiro-cli chat --no-interactive --resume-id <agentSessionId> [trust flags]`.
// ok is false when the hook-derived native session id has not landed yet, so
// callers can fall back to fresh launch behavior.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.kiroBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 8)
	cmd = append(cmd, binary, "chat", "--no-interactive", "--resume-id", agentSessionID)
	appendApprovalFlags(&cmd, cfg.Permissions)
	return cmd, true, nil
}

// SessionInfo surfaces Kiro hook-derived metadata. Metadata is intentionally
// nil for Kiro: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[kiroTitleMetadataKey],
		Summary:        session.Metadata[kiroSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// ResolveKiroBinary returns the path to the kiro-cli binary on this machine,
// searching PATH then a handful of well-known install locations. Returns
// "kiro-cli" as a last-ditch fallback so callers see a clear "command not
// found" rather than an empty argv.
func ResolveKiroBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"kiro-cli.cmd", "kiro-cli.exe", "kiro-cli"} {
			path, err := exec.LookPath(name)
			if err == nil && path != "" {
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		candidates := []string{}
		if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
			candidates = append(candidates,
				filepath.Join(localAppData, "Programs", "kiro", "kiro-cli.exe"),
			)
		}
		if appData := os.Getenv("APPDATA"); appData != "" {
			candidates = append(candidates,
				filepath.Join(appData, "npm", "kiro-cli.cmd"),
				filepath.Join(appData, "npm", "kiro-cli.exe"),
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates,
				filepath.Join(home, ".kiro", "bin", "kiro-cli.exe"),
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

		return "", fmt.Errorf("kiro: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("kiro-cli"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/kiro-cli",
		"/opt/homebrew/bin/kiro-cli",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".kiro", "bin", "kiro-cli"),
			filepath.Join(home, ".local", "bin", "kiro-cli"),
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

	return "", fmt.Errorf("kiro: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) kiroBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveKiroBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// appendApprovalFlags maps AO's 4 permission modes onto Kiro's tool-trust
// flags. Default emits no flag so Kiro defers to the user's own configuration
// (the interactive per-tool prompt). accept-edits grants the write-capable
// built-in tools; auto/bypass grant all tools.
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's Kiro config / per-tool prompting.
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--trust-tools=fs_read,fs_write")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--trust-all-tools")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--trust-all-tools")
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
