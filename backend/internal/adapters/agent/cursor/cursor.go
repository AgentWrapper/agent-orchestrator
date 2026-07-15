// Package cursor implements the Cursor CLI agent adapter: launching new
// sessions, resuming hook-tracked sessions, installing workspace-local hooks,
// and reading hook-derived session info.
//
// AO-managed sessions derive native session identity and display
// metadata from Cursor hooks instead of transcript/cache scans. The driven
// binary is `cursor-agent` (not the `cursor` editor binary).
package cursor

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
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Plugin is the Cursor agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Cursor adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// cursorDataDir returns the isolated Cursor profile AO uses for managed Cursor
// sessions. This keeps Cursor's trust/cache state under AO_DATA_DIR instead of
// the user's normal ~/.cursor profile.
func cursorDataDir(dataDir string) string {
	return filepath.Join(dataDir, "cursor")
}

// AugmentRuntimeEnv points cursor-agent at AO's isolated Cursor profile so
// workspace trust seeded during hook installation is read by the launched
// process without modifying the user's normal Cursor state.
func (p *Plugin) AugmentRuntimeEnv(env map[string]string, dataDir string) {
	if strings.TrimSpace(dataDir) == "" {
		return
	}
	env[cursorDataDirEnv] = cursorDataDir(dataDir)
}

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "cursor",
		Name:        "Cursor",
		Description: "Run Cursor CLI agent worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a new interactive Cursor CLI
// session:
//
//	cursor-agent [permission flags] <prompt>
//
// The prompt is positional and must come last, so a leading "-" is not read as
// a flag.
//
// Cursor has no inline/file system-prompt flag: it reads workspace rule files
// (AGENTS.md, .cursor/rules, CLAUDE.md). SystemPrompt/SystemPromptFile are
// therefore not injected via a launch flag here.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.cursorBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendApprovalFlags(&cmd, cfg.Permissions)

	// Prompt is positional and must be last. The `--` sentinel ends option
	// parsing so a leading "-" in the prompt is not read as a flag.
	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Cursor CLI
// session:
//
//	cursor-agent [perm flags] --resume <id>
//
// ok is false when the hook-derived native session id has not landed yet, so
// callers can fall back to fresh launch behavior. ports.RestoreConfig carries no
// prompt, so none is appended.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.cursorBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 6)
	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--resume", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Cursor hook-derived metadata. Metadata is intentionally
// nil for Cursor: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// ResolveCursorBinary returns the path to the cursor-agent binary on this
// machine, searching PATH then a handful of well-known install locations.
// Returns "cursor-agent" as a last-ditch fallback so callers see a clear
// "command not found" rather than an empty argv.
func ResolveCursorBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"cursor-agent.exe", "cursor-agent.cmd", "cursor-agent"} {
			path, err := exec.LookPath(name)
			if err == nil && path != "" {
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}
		return "", fmt.Errorf("cursor: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("cursor-agent"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".local", "bin", "cursor-agent"))
	}
	candidates = append(candidates,
		"/usr/local/bin/cursor-agent",
		"/opt/homebrew/bin/cursor-agent",
	)

	for _, candidate := range candidates {
		if hookutil.FileExists(candidate) {
			return candidate, nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("cursor: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) cursorBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveCursorBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's Cursor config approvalMode.
	case ports.PermissionModeAcceptEdits:
		// No dedicated accept-edits flag exists; cursor has no accept-edits
		// flag, it is governed by .cursor/cli.json permissions.
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--force")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--yolo")
	}
}
