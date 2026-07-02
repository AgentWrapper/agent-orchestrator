// Package agy implements the Agy (Antigravity) agent adapter: launching new sessions,
// resuming sessions by native ID, installing workspace-local hooks, and reading
// hook-derived session info.
package agy

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
	adapterID = "agy"

	// Normalized session-metadata keys. Shared vocabulary with the Codex and Claude Code
	// adapters so the dashboard treats every agent uniformly.
	agyTitleMetadataKey   = "title"
	agySummaryMetadataKey = "summary"
)

// Plugin is the Agy agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.RWMutex
	resolvedBinary string
}

// New returns a ready-to-register Agy adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Agy fires a before-agent hook that flips the
// session active after a prompt is submitted. See ports.ActivitySignaler.
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
		Name:        "Agy",
		Description: "Run Agy (Antigravity) worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Agy exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start an interactive Agy session.
// Shape:
//
//	agy --add-dir <WorkspacePath> [--dangerously-skip-permissions] [--prompt-interactive <Prompt>]
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.agyBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}

	if cfg.WorkspacePath != "" {
		cmd = append(cmd, "--add-dir", cfg.WorkspacePath)
	}

	if cfg.Permissions == ports.PermissionModeBypassPermissions {
		cmd = append(cmd, "--dangerously-skip-permissions")
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, "--prompt-interactive", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Agy receives its prompt in the
// launch command itself via --prompt-interactive.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Agy session:
// `agy --add-dir <WorkspacePath> [--dangerously-skip-permissions] --conversation <agentSessionId>`.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}

	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.agyBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = []string{binary}

	if cfg.Session.WorkspacePath != "" {
		cmd = append(cmd, "--add-dir", cfg.Session.WorkspacePath)
	}

	if cfg.Permissions == ports.PermissionModeBypassPermissions {
		cmd = append(cmd, "--dangerously-skip-permissions")
	}

	cmd = append(cmd, "--conversation", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Agy hook-derived metadata.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[agyTitleMetadataKey],
		Summary:        session.Metadata[agySummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// ResolveAgyBinary returns the path to the agy binary on this machine,
// searching PATH then a handful of well-known install locations.
// Returns "agy" as a last-ditch fallback.
func ResolveAgyBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"agy.cmd", "agy.exe", "agy"} {
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
				filepath.Join(appData, "npm", "agy.cmd"),
				filepath.Join(appData, "npm", "agy.exe"),
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".cargo", "bin", "agy.exe"))
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				return candidate, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		return "", fmt.Errorf("agy: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("agy"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/agy",
		"/opt/homebrew/bin/agy",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "agy"),
			filepath.Join(home, ".cargo", "bin", "agy"),
			filepath.Join(home, ".npm", "bin", "agy"),
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

	return "", fmt.Errorf("agy: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) agyBinary(ctx context.Context) (string, error) {
	// Fast path: a concurrent-safe read of the already-resolved binary.
	p.binaryMu.RLock()
	cached := p.resolvedBinary
	p.binaryMu.RUnlock()
	if cached != "" {
		return cached, nil
	}

	// Populate path: take the write lock and re-check, since another goroutine
	// may have resolved the binary between releasing RLock and acquiring Lock.
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()
	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveAgyBinary(ctx)
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
