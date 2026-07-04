// Package copilot implements the GitHub Copilot CLI agent adapter: launching new
// headless sessions, resuming hook-tracked sessions, installing workspace-local
// hooks, and reading hook-derived session info.
//
// This adapter targets the standalone agentic GitHub Copilot CLI (binary
// "copilot", installed via npm "@github/copilot"), NOT the older `gh copilot`
// suggest/explain extension.
//
// Launch runs the CLI in interactive mode so AO can keep a durable terminal
// pane attached to the session. Permission modes map onto the CLI's allow flags
// (`--allow-tool`, `--allow-all-tools`, `--allow-all`).
// Restore continues an existing session via `--resume <agentSessionId>`; the
// native session id (a UUID under ~/.copilot/session-state/) is captured by the
// SessionStart hook AO installs (see hooks.go).
//
// AO-managed sessions derive native session identity and display metadata from
// Copilot hooks instead of transcript/cache scans.
package copilot

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
	adapterID = "copilot"

	copilotTitleMetadataKey   = "title"
	copilotSummaryMetadataKey = "summary"
)

// Plugin is the GitHub Copilot CLI agent adapter. It is safe for concurrent use;
// the binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Copilot adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "GitHub Copilot",
		Description: "Run GitHub Copilot CLI worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Copilot exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new interactive Copilot session:
//
//	copilot [permission flags]
//
// The prompt is delivered after the process starts; using `-p` runs Copilot in
// programmatic mode and exits when done, which leaves AO's terminal pane blank
// or dead. Copilot CLI does not have a documented system-prompt-injection flag,
// so SystemPrompt/SystemPromptFile are ignored.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.copilotBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendApprovalFlags(&cmd, cfg.Permissions)

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Copilot receives its prompt after the
// interactive process starts.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryAfterStart, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Copilot
// session: `copilot [permission flags] --resume <agentSessionId> [-p <prompt>]`.
// ok is false when the hook-derived native session id has not landed yet, so
// callers can fall back to fresh launch behavior.
//
// ports.RestoreConfig carries no Prompt field, so resume is issued without a new
// `-p`; the manager re-sends the prompt through its own delivery path when one is
// needed.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.copilotBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 8)
	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--resume", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Copilot hook-derived metadata. Metadata is intentionally
// nil for Copilot: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[copilotTitleMetadataKey],
		Summary:        session.Metadata[copilotSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// ResolveCopilotBinary returns the path to the copilot binary on this machine,
// searching PATH then a handful of well-known install locations (npm global,
// Homebrew). Returns "copilot" as a last-ditch fallback so callers see a clear
// "command not found" rather than an empty argv.
func ResolveCopilotBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"copilot.cmd", "copilot.exe", "copilot"} {
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
				filepath.Join(appData, "npm", "copilot.cmd"),
				filepath.Join(appData, "npm", "copilot.exe"),
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".copilot", "bin", "copilot.exe"))
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				return candidate, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		return "", fmt.Errorf("copilot: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("copilot"); err == nil && path != "" {
		if native := copilotNativeBinaryForLoader(path); native != "" {
			return native, nil
		}
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/copilot",
		"/opt/homebrew/bin/copilot",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".copilot", "bin", "copilot"),
			filepath.Join(home, ".npm", "bin", "copilot"),
			filepath.Join(home, ".local", "bin", "copilot"),
			filepath.Join(home, "Library", "Application Support", "Code", "User", "globalStorage", "github.copilot-chat", "copilotCli", "copilot"),
		)
	}

	for _, candidate := range candidates {
		if fileExists(candidate) {
			if native := copilotNativeBinaryForLoader(candidate); native != "" {
				return native, nil
			}
			return candidate, nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("copilot: %w", ports.ErrAgentBinaryNotFound)
}

func copilotNativeBinaryForLoader(path string) string {
	if path == "" || runtime.GOOS == "windows" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || filepath.Base(resolved) != "npm-loader.js" {
		return ""
	}
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "darwin"
	}
	native := filepath.Join(filepath.Dir(resolved), "node_modules", ".bin", "copilot-"+platform+"-"+runtime.GOARCH)
	if fileExists(native) {
		return native
	}
	return ""
}

func (p *Plugin) copilotBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveCopilotBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// appendApprovalFlags maps AO's 4 permission modes onto Copilot CLI approval
// flags (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference):
//
//	default            → no flag (defer to ~/.copilot config / per-tool prompts)
//	accept-edits       → --allow-tool 'write' (auto-approve file edits only)
//	auto               → --allow-all-tools (auto-approve every tool, still scoped paths/urls)
//	bypass-permissions → --allow-all (full bypass: tools, paths, urls)
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's ~/.copilot config / interactive prompts.
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--allow-tool", "write")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--allow-all-tools")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--allow-all")
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
