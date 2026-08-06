// Package muse implements the Muse Code CLI agent adapter.
//
// Muse is distributed as the Python package "code-muse" and installs the
// executable "muse". AO launches `muse --interactive` and supplies an initial
// task as a positional command after `--`. Muse's `-p/--prompt` mode is not
// used because it executes one prompt and exits instead of keeping the
// interactive prompt-toolkit session attached to AO's terminal.
//
// Muse has no permission-mode launch flags; its approval behavior is configured
// through yolo_mode in muse.cfg. It reads project instructions from
// .muse/AGENTS.md, which GetAgentHooks uses for AO's standing instructions.
package muse

import (
	"context"
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
//	muse --interactive [--model <model>] [-- <prompt>]
//
// A prompt is positional, not passed through -p/--prompt, because that flag is
// Muse's single-prompt mode and exits after the response. The `--` terminator
// keeps prompts beginning with a dash from being parsed as Muse flags.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
	binary, err := p.museBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd := []string{binary, "--interactive"}
	agentbase.AppendModelFlag(&cmd, cfg.Config, "--model")
	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}
	return cmd, nil
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
		{".local", "bin", "muse"}, // uv tool, pipx, and common pip user installs
		{".pyenv", "shims", "muse"},
		{"Library", "Python", "3.14", "bin", "muse"},
	},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinLocalAppData, Parts: []string{"Programs", "Python", "Python314", "Scripts", "muse.exe"}},
		{Base: binaryutil.WinAppData, Parts: []string{"Python", "Python314", "Scripts", "muse.exe"}},
		{Base: binaryutil.WinHome, Parts: []string{".local", "bin", "muse.exe"}},
	},
}

// ResolveMuseBinary finds the `muse` executable installed by the code-muse
// package, searching PATH and common UV/pip/Python user install locations.
func ResolveMuseBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, museBinarySpec)
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
