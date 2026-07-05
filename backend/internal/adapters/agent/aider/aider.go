// Package aider implements the Aider agent adapter: launching headless Aider
// worker sessions.
//
// Aider is a Tier C adapter: it has no lifecycle hook surface, no native
// session id, and no resume-by-id mechanism, so hook installation, restore, and
// SessionInfo are intentionally no-ops. The permission mapping is lossy because
// Aider lacks a graduated approval ladder or sandbox (see the comments on
// appendApprovalFlags).
package aider

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "aider"

// Plugin is the Aider agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Aider adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Aider",
		Description: "Run Aider worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a headless Aider session:
//
//	aider -m <prompt> [permission flags] --no-check-update --no-stream --no-pretty [--read <system prompt file>]
//
// The prompt is delivered with `-m <prompt>` rather than positionally: Aider
// treats positional arguments as files to add to the chat, so a positional
// prompt would be misread. The `-m` pair is only appended when a prompt is set.
//
// Aider has no inline system-prompt mechanism; only SystemPromptFile is honored
// via --read. The --no-check-update --no-stream --no-pretty flags keep Aider
// well-behaved in a non-interactive, captured-output context.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.aiderBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	if cfg.Prompt != "" {
		cmd = append(cmd, "-m", cfg.Prompt)
	}
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--no-check-update", "--no-stream", "--no-pretty")
	if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "--read", cfg.SystemPromptFile)
	}
	// aider has no inline system-prompt mechanism; only SystemPromptFile is
	// honored via --read. A cfg.SystemPrompt with no file is intentionally
	// dropped here rather than written to disk.
	return cmd, nil
}

// normalizePermissionMode collapses an empty mode onto PermissionModeDefault so
// callers can switch over a stable set of values.
func normalizePermissionMode(mode ports.PermissionMode) ports.PermissionMode {
	if mode == "" {
		return ports.PermissionModeDefault
	}
	return mode
}

// appendApprovalFlags maps AO's permission modes onto Aider's flags. The mapping
// is lossy: Aider has no graduated approval ladder and no sandbox, so multiple
// AO modes collapse onto the same Aider behavior.
func appendApprovalFlags(cmd *[]string, mode ports.PermissionMode) {
	switch normalizePermissionMode(mode) {
	case ports.PermissionModeDefault:
		// No flags: Aider's interactive confirmation prompts apply. In headless
		// -m mode an unanswered confirm can hang; this is acceptable and
		// documented, deferring the choice to the user's own Aider config.
	case ports.PermissionModeAcceptEdits:
		// Apply edits without prompting but leave them uncommitted.
		*cmd = append(*cmd, "--yes-always", "--no-auto-commits")
	case ports.PermissionModeAuto:
		// Apply edits without prompting and keep Aider's default auto-commit.
		*cmd = append(*cmd, "--yes-always")
	case ports.PermissionModeBypassPermissions:
		// Lossy: Aider has no sandbox/bypass, so this is identical to auto.
		*cmd = append(*cmd, "--yes-always")
	default:
		// Unhandled/future modes: no flags, deferring to the user's Aider config.
	}
}

// ResolveAiderBinary finds the `aider` binary, searching PATH then common
// install locations. It returns "aider" as a last resort so callers get the
// shell's normal command-not-found behavior if Aider is absent.
func ResolveAiderBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"aider.exe", "aider.cmd", "aider"} {
			if path, err := exec.LookPath(name); err == nil && path != "" {
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}
		return "", fmt.Errorf("aider: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("aider"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/aider",
		"/opt/homebrew/bin/aider",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append([]string{filepath.Join(home, ".local", "bin", "aider")}, candidates...)
	}

	for _, candidate := range candidates {
		if hookutil.FileExists(candidate) {
			return candidate, nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("aider: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) aiderBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveAiderBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
