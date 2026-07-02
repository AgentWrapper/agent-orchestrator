// Package cline implements the Cline CLI agent adapter: launching new
// headless sessions, resuming sessions by native session id, installing
// workspace-local Cline hooks, and reading hook-derived session info.
//
// Cline is an autonomous coding agent that runs in the terminal (binary
// "cline", installed via `npm i -g cline`). AO drives task launches headlessly
// by passing the prompt as a positional argument and requesting NDJSON output
// with `--json`, which Cline emits one event per line for machine parsing.
// Promptless launches (notably orchestrators) must stay in Cline's interactive
// mode because Cline rejects `--json` without a prompt or piped stdin.
//
// AO-managed sessions derive native session identity from Cline hooks
// (the workspace-local `.clinerules/hooks/` executable scripts AO installs)
// rather than transcript/cache scans.
package cline

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
	clineTitleMetadataKey   = "title"
	clineSummaryMetadataKey = "summary"
)

// Plugin is the Cline agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Cline adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "cline",
		Name:        "Cline",
		Description: "Run Cline worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Cline exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new Cline session. Prompted
// launches request machine-readable NDJSON output (`--json`). Promptless
// launches stay interactive because Cline's JSON output mode requires a prompt
// argument or piped stdin. The prompt is placed after `--` so a leading "-" is
// not read as a flag.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.clineBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	if cfg.Prompt != "" {
		cmd = append(cmd, "--json")
	}
	appendApprovalFlags(&cmd, cfg.Permissions)

	if cfg.SystemPrompt != "" {
		cmd = append(cmd, "-s", cfg.SystemPrompt)
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Cline receives its prompt in the
// launch command itself (as a positional argument).
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Cline session:
// `cline [approval flags] --id <agentSessionId>`. Resumes are interactive
// because no prompt is supplied here. ok is false when the hook-derived native
// session id has not landed yet, so callers can fall back to fresh launch
// behavior.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.clineBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 8)
	cmd = append(cmd, binary)
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--id", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Cline hook-derived metadata. Metadata is intentionally
// nil for Cline: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[clineTitleMetadataKey],
		Summary:        session.Metadata[clineSummaryMetadataKey],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// ResolveClineBinary returns the path to the cline binary on this machine,
// searching PATH then a handful of well-known install locations
// (Homebrew, npm global). Returns "cline" as a last-ditch fallback so callers
// see a clear "command not found" rather than an empty argv.
func ResolveClineBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"cline.cmd", "cline.exe", "cline"} {
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
				filepath.Join(appData, "npm", "cline.cmd"),
				filepath.Join(appData, "npm", "cline.exe"),
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

		return "", fmt.Errorf("cline: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("cline"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/cline",
		"/opt/homebrew/bin/cline",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".npm-global", "bin", "cline"),
			filepath.Join(home, ".npm", "bin", "cline"),
			filepath.Join(home, ".local", "bin", "cline"),
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

	return "", fmt.Errorf("cline: %w", ports.ErrAgentBinaryNotFound)
}

func (p *Plugin) clineBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveClineBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's Cline config/default behavior.
	case ports.PermissionModeAcceptEdits:
		// Edit-accepting mode: turn on Cline's auto-approval so edits are
		// applied without prompting, matching the AcceptEdits semantics every
		// other adapter uses (the more-permissive, edit-accepting mode).
		*cmd = append(*cmd, "--auto-approve", "true")
	case ports.PermissionModeAuto:
		// Auto-approve every tool for unattended runs.
		*cmd = append(*cmd, "--auto-approve", "true")
	case ports.PermissionModeBypassPermissions:
		// yolo mode: auto-approve tools with the restricted (safer) toolset.
		*cmd = append(*cmd, "--yolo")
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
