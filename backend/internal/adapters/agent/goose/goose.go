// Package goose implements the Goose (Block) agent adapter: launching new
// headless sessions, resuming hook-tracked sessions, installing
// workspace-local lifecycle hooks, and reading hook-derived session info.
//
// Goose (binary "goose") runs headlessly via `goose run -t "<text>"`. It has a
// native Claude-Code-style lifecycle hook system (released 2026-05): a plugin
// directory under <workspace>/.agents/plugins/<name>/hooks/hooks.json is
// auto-discovered at startup and its commands run on SessionStart /
// UserPromptSubmit / Stop / etc. AO installs its hooks there, so AO derives
// native session identity and activity from Goose hooks (Tier A), the same way
// the Codex adapter does.
//
// Permission/approval is controlled by the GOOSE_MODE environment variable
// (auto / approve / chat / smart_approve), not a CLI flag, so non-default modes
// are delivered as an `env GOOSE_MODE=<mode>` argv prefix (the same technique
// the opencode adapter uses for OPENCODE_PERMISSION). The default mode emits no
// prefix so Goose defers to the user's own config.
//
// Note: the AO repo also vendors pressly/goose as its SQLite migration tool,
// but that is a different Go import path; this package's name `goose` only
// collides at the import-alias level, which central wiring resolves.
package goose

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	adapterID = "goose"

	// gooseModeEnvVar is the only permission-control surface Goose honors: the
	// approval mode is read from this process env var, not from any CLI flag.
	gooseModeEnvVar = "GOOSE_MODE"
)

// Plugin is the Goose agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Goose adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals Goose fires a user-prompt-submit hook under AO's
// launch. See ports.ActivitySignaler.
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
		Name:        "Goose",
		Description: "Run Goose worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a new headless Goose session:
//
//	[env GOOSE_MODE=<mode>] goose run [--system <text>] -t <prompt>
//
// The prompt is delivered in-command via `-t`. A non-default permission mode is
// rendered as an `env GOOSE_MODE=<mode>` prefix because Goose reads its approval
// mode from the environment, not from a flag. System instructions, when present,
// are passed via `--system`. Goose requires one of --instructions, --text, or
// --recipe even when AO intentionally starts a promptless orchestrator, so empty
// prompts are delivered as `-t "" --interactive` to land in an input-ready
// terminal without inventing an initial task.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.gooseBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = append(gooseModeEnvPrefix(cfg.Permissions), binary, "run")

	systemPrompt, err := systemPromptText(cfg)
	if err != nil {
		return nil, err
	}
	if systemPrompt != "" {
		cmd = append(cmd, "--system", systemPrompt)
	}

	cmd = append(cmd, "-t", cfg.Prompt)
	if cfg.Prompt == "" {
		cmd = append(cmd, "--interactive")
	}

	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Goose session:
//
//	[env GOOSE_MODE=<mode>] goose run --resume --session-id <agentSessionId>
//
// ok is false when the hook-derived native session id has not landed yet, so
// callers can fall back to fresh launch behavior.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.gooseBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = append(gooseModeEnvPrefix(cfg.Permissions), binary, "run", "--resume", "--session-id", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Goose hook-derived metadata. Metadata is intentionally
// nil for Goose: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// systemPromptText returns the system instructions to inject. Goose's `--system`
// flag takes inline text only (no file variant), so a system-prompt file is read
// from disk and its contents inlined. A read failure is surfaced as an error so a
// misconfigured prompt file does not silently fall back to the inline
// SystemPrompt string; only an empty-after-trim file falls back.
func systemPromptText(cfg ports.LaunchConfig) (string, error) {
	if cfg.SystemPromptFile != "" {
		data, err := os.ReadFile(cfg.SystemPromptFile) //nolint:gosec // path is AO-owned launch config
		if err != nil {
			return "", fmt.Errorf("read %s: %w", cfg.SystemPromptFile, err)
		}
		if text := strings.TrimSpace(string(data)); text != "" {
			return text, nil
		}
	}
	return cfg.SystemPrompt, nil
}

// gooseModeEnvPrefix renders mode as an `env GOOSE_MODE=<mode>` argv prefix, or
// nil for the default mode.
//
// The var must reach Goose as a process env var, not an argv flag. The runtime
// runs the argv through a shell, which execs `env`, which sets the var and execs
// goose. A bare `GOOSE_MODE=...` argv element would not work: the runtime
// shell-quotes every element, and a quoted token is run as a command rather than
// read as an assignment — hence the explicit `env` wrapper. POSIX-only, which
// matches the runtime.
func gooseModeEnvPrefix(mode ports.PermissionMode) []string {
	value := gooseMode(mode)
	if value == "" {
		return nil
	}
	return []string{"env", gooseModeEnvVar + "=" + value}
}

// gooseMode maps an AO permission mode onto Goose's GOOSE_MODE value.
//
//   - default            → "": no env; Goose's own config decides approvals.
//   - accept-edits       → smart_approve: auto-approves safe edits, asks on risk.
//   - auto               → auto: fully autonomous, no approval prompts.
//   - bypass-permissions → auto: Goose's fully-autonomous mode is the nearest
//     equivalent to bypass.
func gooseMode(mode ports.PermissionMode) string {
	switch ports.NormalizePermissionMode(mode) {
	case ports.PermissionModeAcceptEdits:
		return "smart_approve"
	case ports.PermissionModeAuto:
		return "auto"
	case ports.PermissionModeBypassPermissions:
		return "auto"
	default:
		return ""
	}
}

// gooseBinarySpec locates the goose binary: PATH first, then the install
// script's ~/.local/bin, Homebrew, Cargo, and npm global locations.
var gooseBinarySpec = binaryutil.BinarySpec{
	Label:         "goose",
	Names:         []string{"goose"},
	WinNames:      []string{"goose.cmd", "goose.exe", "goose"},
	UnixPaths:     []string{"/usr/local/bin/goose", "/opt/homebrew/bin/goose"},
	UnixHomePaths: [][]string{{".local", "bin", "goose"}, {".cargo", "bin", "goose"}, {".npm", "bin", "goose"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "goose.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "goose.exe"}},
		{Base: binaryutil.WinLocalAppData, Parts: []string{"Programs", "goose", "goose.exe"}},
		{Base: binaryutil.WinHome, Parts: []string{".cargo", "bin", "goose.exe"}},
	},
}

// ResolveGooseBinary returns the path to the goose binary, or a wrapped
// ports.ErrAgentBinaryNotFound when it is absent.
func ResolveGooseBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, gooseBinarySpec)
}

func (p *Plugin) gooseBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveGooseBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
