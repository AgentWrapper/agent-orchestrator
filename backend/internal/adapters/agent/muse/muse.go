// Package muse implements the Muse Code CLI agent adapter.
//
// Muse Code is Meta's terminal coding agent, installed from
// https://dev.meta.ai/install.sh as the executable "muse". With no subcommand
// it opens the interactive TUI, and an optional positional prompt starts the
// first turn without leaving that TUI.
//
// Muse reads trusted project instructions from the workspace-root AGENTS.md,
// which GetAgentHooks uses for AO's standing instructions.
package muse

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "muse"

// Plugin is the Muse Code CLI agent adapter. It is safe for concurrent use;
// the binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Muse adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Muse Code",
		Description: "Run Muse Code CLI worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports Muse's optional model override.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	return agentbase.ModelConfigSpec(ctx, "Model override passed to `muse --model`.")
}

// GetLaunchCommand builds the argv for a persistent interactive Muse session:
//
//	muse --trust-workspace [--approval-mode never|--yolo] [--model <model>] [prompt]
//
// The prompt is the CLI's documented optional positional argument. `muse exec`
// is deliberately not used because it is headless and exits after one turn.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
	binary, err := p.museBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd := []string{binary, "--trust-workspace"}
	appendApprovalFlags(&cmd, cfg.Permissions)
	agentbase.AppendModelFlag(&cmd, cfg.Config, "--model")
	if cfg.Prompt != "" {
		cmd = append(cmd, cfg.Prompt)
	}
	return cmd, nil
}

func appendApprovalFlags(cmd *[]string, mode ports.PermissionMode) {
	switch mode {
	case ports.PermissionModeAcceptEdits, ports.PermissionModeAuto:
		*cmd = append(*cmd, "--approval-mode", "never")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--yolo")
	}
}

var museBinarySpec = binaryutil.BinarySpec{
	Label:    "muse",
	Names:    []string{"muse"},
	WinNames: []string{"muse.exe", "muse.cmd", "muse"},
	UnixPaths: []string{
		"/usr/local/bin/muse",
		"/opt/homebrew/bin/muse",
	},
	UnixHomePaths: [][]string{
		{".local", "bin", "muse"}, // official Meta installer default
	},
}

// ResolveMuseBinary finds the official Meta Muse Code launcher. The `muse`
// command name is shared by unrelated tools, so a version-signature check keeps
// those shims from being reported as an installed AO harness.
func ResolveMuseBinary(ctx context.Context) (string, error) {
	binary, err := binaryutil.ResolveBinary(ctx, museBinarySpec)
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, binary, "--version")
	cmd.Env = append(os.Environ(), "MUSE_NO_AUTO_UPDATE=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("muse: verify official Meta Muse Code CLI at %s: %w", binary, err)
	}
	if !strings.HasPrefix(strings.TrimSpace(string(out)), "Muse Code ") {
		return "", fmt.Errorf("muse: %s is not the official Meta Muse Code CLI: %w", binary, ports.ErrAgentBinaryNotFound)
	}
	return binary, nil
}

func (p *Plugin) museBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}
	binary, err := ResolveMuseBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
