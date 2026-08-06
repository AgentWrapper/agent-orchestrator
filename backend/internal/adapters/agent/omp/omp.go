// Package omp implements the Oh My Pi agent adapter: launching new
// interactive OMP sessions, resuming sessions by native session id, and
// mapping AO's permission modes onto OMP's approval-mode flags.
//
// Oh My Pi ("@oh-my-pi/pi-coding-agent", binary "omp") is a terminal coding
// harness distinct from the "pi" adapter already shipped by AO ("pi",
// "@earendil-works/pi-coding-agent") — OMP is a downstream fork/successor of
// that CLI, but the binaries, flags, and session-storage layout have diverged
// enough that OMP needs its own adapter rather than reusing pi's. AO runs OMP
// interactively in the session terminal pane. The initial prompt is delivered
// in-command as a trailing positional message; like pi, OMP's argument parser
// treats a leading "-" on that positional as a flag, so AO relies on prompts
// not beginning with "-".
//
// System prompts: OMP's `--append-system-prompt` flag documents that it
// accepts either literal text or file contents. AO reads SystemPromptFile
// itself and inlines the text (matching the pi/codex adapters) instead of
// relying on OMP's own file-vs-text detection, so a read failure aborts the
// launch instead of silently passing a path OMP may not resolve.
//
// Permissions: OMP sessions run headlessly inside AO's terminal pane, so a
// mode that leaves `exec`-tier tools prompting would hang forever with nobody
// to click approve (see the identical rationale in the codex adapter). OMP's
// `tools.approvalMode` has three tiers (`always-ask`, `write`, `yolo`) plus a
// `--auto-approve` flag that force-overrides to yolo regardless of project
// config:
//   - default / auto  -> `--approval-mode yolo` (headless-safe; matches OMP's
//     own schema default)
//   - accept-edits     -> `--approval-mode write` (auto-approves read+write,
//     still prompts exec — same semantics as Claude Code's acceptEdits)
//   - bypass-permissions -> `--auto-approve` (forces yolo, overriding any
//     project-level approvalMode)
//
// Restore: OMP persists sessions under
// ~/.omp/agent/sessions/<scope>-<project>-<hash>/<timestamp>_<id>.jsonl and
// resumes by id with `-r/--resume <id>` (accepts an id prefix). GetRestoreCommand
// builds that command whenever ports.MetadataKeyAgentSessionID is already
// present in session metadata, but nothing in this adapter populates that key:
// like the pi adapter it mirrors, OMP has no native hook config file AO can
// install (see Hooks below), so no mechanism currently writes the native
// session id back into AO's metadata. In practice GetRestoreCommand's ok=false
// branch is the one that fires today, and AO falls back to a fresh launch.
// Restore becomes reachable once an OMP-specific mechanism (e.g. a `--hook`
// extension that reports the session id back to AO, or a session-file scan
// keyed on cwd) is added to populate that metadata key — tracked as follow-up
// work, not invented here to avoid claiming a capability that isn't wired.
//
// Hooks: OMP's lifecycle-extensibility surface is in-process TypeScript
// extensions (`--hook`/`-e`), not a config file AO can merge into, so hook
// installation is intentionally a no-op (same tradeoff pi documents). This is
// also why restore (above) and SessionInfo (title/summary) are unavailable
// today: both depend on a hook reporting back to AO.
//
// AuthStatus: OMP stores credentials in a multi-provider sqlite `agent.db`
// (table `auth_credentials`, one row per provider credential with a nullable
// `disabled_cause`) rather than a single auth.json/env var. AuthStatus checks
// common provider API-key env vars, then reads agent.db directly, falling back
// to a generic CLI probe. The schema is an internal implementation detail, not
// a public contract: a future OMP release can rename it without notice, so the
// read fails soft (unknown, not a wrong answer) on any schema mismatch.
package omp

import (
	"context"
	"os"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "omp"

// Plugin is the Oh My Pi agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register OMP adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Oh My Pi",
		Description: "Run Oh My Pi (omp) worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the per-project agent config keys OMP understands.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	return agentbase.ModelConfigSpec(ctx, "Model override passed to `omp --model` (fuzzy match, e.g. \"opus\" or \"gpt-5.2\").")
}

// GetLaunchCommand builds the argv to start a new interactive OMP session:
//
//	omp [--append-system-prompt <system prompt>] [--model <model>] [--approval-mode <mode> | --auto-approve] [<prompt>]
//
// The prompt is delivered in-command as a trailing positional message. OMP
// does not honor a `--` options terminator, so the prompt must not begin with
// "-".
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.ompBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	if err := appendSystemPromptFlag(&cmd, cfg.SystemPrompt, cfg.SystemPromptFile); err != nil {
		return nil, err
	}
	agentbase.AppendModelFlag(&cmd, cfg.Config, "--model")
	appendApprovalFlags(&cmd, cfg.Permissions)
	if cfg.Prompt != "" {
		cmd = append(cmd, cfg.Prompt)
	}
	return cmd, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing OMP session
// when a native session id is already present in metadata. OMP resumes by id
// with `--resume <id>` (id prefixes accepted). ok=false when that id is
// absent, which is the current path in practice — see the package doc for why
// nothing populates it yet.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.ompBinary(ctx)
	if err != nil {
		return nil, false, err
	}
	cmd = []string{binary}
	if err := appendSystemPromptFlag(&cmd, cfg.SystemPrompt, cfg.SystemPromptFile); err != nil {
		return nil, false, err
	}
	agentbase.AppendModelFlag(&cmd, cfg.Config, "--model")
	appendApprovalFlags(&cmd, cfg.Permissions)
	cmd = append(cmd, "--resume", agentSessionID)
	return cmd, true, nil
}

// appendSystemPromptFlag reads SystemPromptFile itself (rather than passing
// the path straight through) so a read failure aborts the launch instead of
// silently handing OMP an unresolved path.
func appendSystemPromptFlag(cmd *[]string, systemPrompt, systemPromptFile string) error {
	switch {
	case systemPrompt != "":
		*cmd = append(*cmd, "--append-system-prompt", systemPrompt)
	case systemPromptFile != "":
		data, err := os.ReadFile(systemPromptFile) //nolint:gosec // path is AO-owned launch config
		if err != nil {
			return err
		}
		*cmd = append(*cmd, "--append-system-prompt", string(data))
	}
	return nil
}

// appendApprovalFlags maps AO's permission modes onto OMP's approval-mode
// flags. OMP sessions run headlessly, so every mode resolves to a flag that
// cannot leave a tool call stalled on an unattended approval prompt:
//   - default / auto      -> --approval-mode yolo (auto-approves read, write,
//     and exec tools; matches OMP's own schema default)
//   - accept-edits         -> --approval-mode write (auto-approves read/write,
//     still prompts exec)
//   - bypass-permissions   -> --auto-approve (forces yolo, overriding project
//     config)
func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--approval-mode", "write")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--auto-approve")
	case ports.PermissionModeDefault, ports.PermissionModeAuto:
		*cmd = append(*cmd, "--approval-mode", "yolo")
	}
}

var ompBinarySpec = binaryutil.BinarySpec{
	Label:     "omp",
	Names:     []string{"omp"},
	WinNames:  []string{"omp.cmd", "omp.exe", "omp"},
	UnixPaths: []string{"/usr/local/bin/omp", "/opt/homebrew/bin/omp"},
	UnixHomePaths: [][]string{
		{".bun", "bin", "omp"},
		{".local", "bin", "omp"},
	},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinLocalAppData, Parts: []string{"bun", "bin", "omp.exe"}},
		{Base: binaryutil.WinHome, Parts: []string{".bun", "bin", "omp.exe"}},
	},
}

// ResolveOMPBinary finds the `omp` binary, searching PATH then common install
// locations (OMP ships via Bun, so ~/.bun/bin is checked ahead of generic
// fallbacks). It returns a wrapped ports.ErrAgentBinaryNotFound when OMP is
// absent.
func ResolveOMPBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, ompBinarySpec)
}

func (p *Plugin) ompBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveOMPBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
