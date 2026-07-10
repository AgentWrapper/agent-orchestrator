// Package amp implements the Amp agent adapter: launching new interactive Amp
// sessions and resuming sessions when a native Amp thread id is known.
//
// Amp activity hooks and SessionInfo derivation will likely require an
// Amp-specific TypeScript plugin, similar to opencode. Until that integration
// exists, hook installation and SessionInfo are intentionally no-ops.
package amp

import (
	"context"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "amp"

// Plugin is the Amp agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Amp adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Amp",
		Description: "Run Amp worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a new interactive Amp session:
//
//	amp [-- <prompt>]
//
// The prompt is passed after `--` so a prompt beginning with "-" is not
// mistaken for a flag. Amp has no documented CLI permission-mode or
// system-prompt flags, so Permissions, SystemPrompt, and SystemPromptFile are
// intentionally ignored until Amp exposes supported instruction mechanisms.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	binary, err := p.ampBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}
	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Amp session
// when plugin-derived native session metadata is available. Until that metadata
// exists, ok is false and callers fall back to fresh launch behavior.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.ampBinary(ctx)
	if err != nil {
		return nil, false, err
	}
	// Capacity fits binary + --resume + sessionID.
	cmd = make([]string, 0, 3)
	cmd = append(cmd, binary)
	cmd = append(cmd, "--resume", agentSessionID)
	return cmd, true, nil
}

var ampBinarySpec = binaryutil.BinarySpec{
	Label:         "amp",
	Names:         []string{"amp"},
	WinNames:      []string{"amp.cmd", "amp.exe", "amp"},
	UnixPaths:     []string{"/usr/local/bin/amp", "/opt/homebrew/bin/amp"},
	UnixHomePaths: [][]string{{".local", "bin", "amp"}, {".npm", "bin", "amp"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "amp.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "amp.exe"}},
	},
}

// ResolveAmpBinary finds the `amp` binary, searching PATH then common install
// locations. It returns a wrapped ports.ErrAgentBinaryNotFound when Amp is absent.
func ResolveAmpBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, ampBinarySpec)
}

func (p *Plugin) ampBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveAmpBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
