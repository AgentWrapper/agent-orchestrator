// Package copilot implements the GitHub Copilot CLI agent adapter: launching new
// headless sessions, resuming hook-tracked sessions, installing workspace-local
// hooks, and reading hook-derived session info.
//
// This adapter targets the standalone agentic GitHub Copilot CLI (binary
// "copilot", installed via npm "@github/copilot"), NOT the older `gh copilot`
// suggest/explain extension.
//
// Launch runs the CLI in interactive mode so AO can keep a durable terminal
// pane attached to the session. When AO has an initial task, it uses Copilot's
// `--interactive <prompt>` mode so the task executes immediately instead of
// waiting in the terminal input buffer. Permission modes map onto the CLI's allow
// flags (`--allow-tool`, `--allow-all-tools`, `--allow-all`).
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
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "copilot"

var copilotUnixPaths = []string{
	"/usr/local/bin/copilot",
	"/opt/homebrew/bin/copilot",
}

// Plugin is the GitHub Copilot CLI agent adapter. It is safe for concurrent use;
// the binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
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

// GetLaunchCommand builds the argv to start a new interactive Copilot session:
//
//	copilot [permission flags] [--agent ao-<session>] [--interactive <prompt>]
//
// `--interactive <prompt>` keeps the durable Copilot terminal session open while
// automatically submitting the initial task. `-p` is deliberately avoided
// because it runs Copilot in programmatic mode and exits when done. Copilot CLI
// does not expose a system-prompt flag, so AO installs a per-session custom
// agent profile in GetAgentHooks and selects it here.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.copilotBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	if agentName := copilotAgentName(cfg.SessionID, cfg.SystemPrompt, cfg.SystemPromptFile); agentName != "" {
		cmd = append(cmd, "--agent="+agentName)
	}
	if cfg.Prompt != "" {
		cmd = append(cmd, "--interactive", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Copilot receives its prompt in the
// launch command. This uses `--interactive <prompt>`, not `-p`, so Copilot starts
// executing immediately while keeping the interactive terminal session alive.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Copilot
// session: `copilot [permission flags] --resume <agentSessionId>`.
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

	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	if agentName := copilotAgentName(cfg.Session.ID, cfg.SystemPrompt, cfg.SystemPromptFile); agentName != "" {
		cmd = append(cmd, "--agent="+agentName)
	}
	cmd = append(cmd, "--resume", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Copilot hook-derived metadata. Metadata is intentionally
// nil for Copilot: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// ResolveCopilotBinary returns the path to the copilot binary on this machine,
// searching PATH then a handful of well-known install locations (npm global,
// Homebrew, the VS Code extension's bundled CLI). When the resolved path is the
// npm-loader shim, the platform-native binary is returned instead. This resolver
// stays hand-rolled (rather than binaryutil.ResolveBinary) because of that
// native-loader indirection.
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
			if hookutil.FileExists(candidate) {
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

	candidates := append([]string(nil), copilotUnixPaths...)
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".npm-global", "bin", "copilot"),
			filepath.Join(home, ".npm", "bin", "copilot"),
			filepath.Join(home, ".local", "bin", "copilot"),
			filepath.Join(home, ".copilot", "bin", "copilot"),
			filepath.Join(home, "Library", "Application Support", "Code", "User", "globalStorage", "github.copilot-chat", "copilotCli", "copilot"),
		)
		nodeManagerCandidates, err := binaryutil.UnixNodeManagerBinCandidates(ctx, home, "copilot")
		if err != nil {
			return "", err
		}
		candidates = append(candidates, nodeManagerCandidates...)
	}

	for _, candidate := range candidates {
		if hookutil.FileExists(candidate) {
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
	if hookutil.FileExists(native) {
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

func copilotSystemPromptText(inline, file string) (string, error) {
	if strings.TrimSpace(inline) != "" {
		return strings.TrimRight(inline, "\n"), nil
	}
	if strings.TrimSpace(file) == "" {
		return "", nil
	}
	data, err := os.ReadFile(file) //nolint:gosec // path is AO-owned launch config
	if err != nil {
		return "", fmt.Errorf("copilot: read system prompt file: %w", err)
	}
	return strings.TrimRight(string(data), "\n"), nil
}

func copilotAgentName(sessionID, inlinePrompt, promptFile string) string {
	if strings.TrimSpace(sessionID) == "" {
		return ""
	}
	if strings.TrimSpace(inlinePrompt) == "" && strings.TrimSpace(promptFile) == "" {
		return ""
	}
	return "ao-" + copilotAgentNameReplacer.Replace(strings.TrimSpace(sessionID))
}

var copilotAgentNameReplacer = strings.NewReplacer(
	"/", "-",
	"\\", "-",
	" ", "-",
	"_", "-",
	".", "-",
	":", "-",
)

// appendApprovalFlags maps AO's 4 permission modes onto Copilot CLI approval
// flags (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference):
//
//	default            -> no flag (defer to ~/.copilot config / per-tool prompts)
//	accept-edits       -> --allow-tool 'write' (auto-approve file edits only)
//	auto               -> --allow-all-tools (auto-approve every tool, still scoped paths/urls)
//	bypass-permissions -> --allow-all (full bypass: tools, paths, urls)
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
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
