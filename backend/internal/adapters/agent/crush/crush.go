// Package crush implements the Crush agent adapter: launching new sessions,
// resuming sessions by native ID, and reading session info.
//
// Crush differs from other agents in that it doesn't have full hooks support,
// so GetAgentHooks and SessionInfo are no-ops for now. Session tracking is
// done through basic session ID management only.
package crush

import (
	"context"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// adapterID is the registry id and the value users pass to
	// `ao spawn --agent`. It matches domain.HarnessCrush.
	adapterID = "crush"
)

// Plugin is the Crush agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Crush adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Crush",
		Description: "Run Crush worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start an interactive Crush session.
// Shape:
//
//	crush [--cwd <WorkspacePath>] [--yolo] [-- <Prompt>]
//
// The session runs in the worktree (cwd is set by the runtime). Crush doesn't
// have native system prompt support, so cfg.SystemPrompt / SystemPromptFile are
// intentionally ignored. The initial task prompt is delivered as a positional
// argument after `--`. The --yolo flag corresponds to bypass-permissions mode.
//
// We intentionally do not pass --session on launch: cfg.SessionID is the
// AO-internal id, not a Crush-native session id. Letting Crush mint its own
// native session id (captured by hooks into session metadata) keeps launch
// consistent with GetRestoreCommand, which resumes using that native id.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.crushBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}

	// Crush uses --cwd to set working directory
	if cfg.WorkspacePath != "" {
		cmd = append(cmd, "--cwd", cfg.WorkspacePath)
	}

	// Handle permission modes
	if cfg.Permissions == ports.PermissionModeBypassPermissions {
		cmd = append(cmd, "--yolo")
	}

	// Prompt is passed after `--` so a leading "-" is not read as a flag
	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Crush session:
// `crush [--cwd <WorkspacePath>] [--yolo] --session <agentSessionId>`.
// It re-applies the permission flag but not the prompt, which the session
// already carries. ok is false when the native session id is not available.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.crushBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = []string{binary}

	if cfg.Session.WorkspacePath != "" {
		cmd = append(cmd, "--cwd", cfg.Session.WorkspacePath)
	}

	if cfg.Permissions == ports.PermissionModeBypassPermissions {
		cmd = append(cmd, "--yolo")
	}

	cmd = append(cmd, "--session", agentSessionID)
	return cmd, true, nil
}

var crushBinarySpec = binaryutil.BinarySpec{
	Label:         "crush",
	Names:         []string{"crush"},
	WinNames:      []string{"crush.cmd", "crush.exe", "crush"},
	UnixPaths:     []string{"/usr/local/bin/crush", "/opt/homebrew/bin/crush"},
	UnixHomePaths: [][]string{{".local", "bin", "crush"}, {".cargo", "bin", "crush"}, {".npm", "bin", "crush"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "crush.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "crush.exe"}},
		{Base: binaryutil.WinHome, Parts: []string{".cargo", "bin", "crush.exe"}},
	},
}

// ResolveCrushBinary returns the path to the crush binary on this machine,
// searching PATH then a handful of well-known install locations. It returns a
// wrapped ports.ErrAgentBinaryNotFound when crush is absent.
func ResolveCrushBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, crushBinarySpec)
}

func (p *Plugin) crushBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveCrushBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
