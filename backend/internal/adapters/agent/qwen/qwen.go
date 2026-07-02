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
	qwenTitleMetadataKey   = "title"
	qwenSummaryMetadataKey = "summary"
)

// Plugin is the Qwen Code agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Qwen Code adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Qwen Code fires a user-prompt-submit hook under
// AO's launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

func (p *Plugin) EmitsBlockedActivity() bool { return true }

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

// GetConfigSpec reports the agent-specific config keys. Qwen Code exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
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

// GetPromptDeliveryStrategy reports that Qwen Code receives its prompt in the
// launch command itself (via -p).
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
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
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[qwenTitleMetadataKey],
		Summary:        session.Metadata[qwenSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// ResolveQwenBinary returns the path to the qwen binary on this machine,
// searching PATH then a handful of well-known install locations (Homebrew, npm
// global). Returns ports.ErrAgentBinaryNotFound when none of those find the
// binary — better than the previous silent `"qwen"` fallback, which let an
// empty tmux pane masquerade as a live session.
func ResolveQwenBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"qwen.cmd", "qwen.exe", "qwen"} {
			path, err := exec.LookPath(name)
			if err == nil && path != "" {
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		candidates := []string{}
		if appData := os.Getenv("APPDATA"); appData != "" {
			candidates = append(candidates,
				filepath.Join(appData, "npm", "qwen.cmd"),
				filepath.Join(appData, "npm", "qwen.exe"),
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

		return "", fmt.Errorf("qwen: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("qwen"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/qwen",
		"/opt/homebrew/bin/qwen",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".npm-global", "bin", "qwen"),
			filepath.Join(home, ".npm", "bin", "qwen"),
			filepath.Join(home, ".local", "bin", "qwen"),
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

	return "", fmt.Errorf("qwen: %w", ports.ErrAgentBinaryNotFound)
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
	switch normalizePermissionMode(permissions) {
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
