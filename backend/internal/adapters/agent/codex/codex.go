// Package codex implements the Codex agent adapter: launching new sessions,
// resuming hook-tracked sessions, installing workspace-local hooks, and reading
// hook-derived session info.
//
// AO-managed sessions derive native session identity and display
// metadata from Codex hooks instead of transcript/cache scans.
package codex

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Plugin is the Codex agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Codex adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)
var _ ports.AgentAuthChecker = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          "codex",
		Name:        "Codex",
		Description: "Run Codex worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the agent-specific config keys. Codex exposes none yet.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start a new Codex session, applying the
// no-update-check, hook-trust bypass, and approval flags, AO's session-flag
// activity hooks, the workspace trust override, optional system-prompt
// instructions, and the initial prompt (passed after `--` so a leading "-" is
// not read as a flag).
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.codexBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	appendNoUpdateCheckFlag(&cmd)
	appendHideRateLimitNudgeFlag(&cmd)
	appendHookTrustBypassFlag(&cmd)
	appendApprovalFlags(&cmd, cfg.Permissions)
	appendSessionHookFlags(&cmd)
	appendTerminalCompatibilityFlags(&cmd)
	appendWorkspaceTrustFlag(&cmd, cfg.WorkspacePath)

	if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "-c", "model_instructions_file="+cfg.SystemPromptFile)
	} else if cfg.SystemPrompt != "" {
		cmd = append(cmd, "-c", "developer_instructions="+codexTOMLConfigString(cfg.SystemPrompt))
	}

	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports that Codex receives its prompt in the
// launch command itself.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv that continues an existing Codex
// session: `codex resume <agentSessionId>`. ok is false when the hook-derived
// native session id has not landed yet, so callers can fall back to fresh
// launch behavior.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.codexBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 24)
	cmd = append(cmd, binary, "resume")
	appendNoUpdateCheckFlag(&cmd)
	appendHideRateLimitNudgeFlag(&cmd)
	appendHookTrustBypassFlag(&cmd)
	appendApprovalFlags(&cmd, cfg.Permissions)
	appendSessionHookFlags(&cmd)
	appendTerminalCompatibilityFlags(&cmd)
	appendWorkspaceTrustFlag(&cmd, cfg.Session.WorkspacePath)
	cmd = append(cmd, agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Codex hook-derived metadata. Metadata is intentionally
// nil for Codex: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[ports.MetadataKeyTitle],
		Summary:        session.Metadata[ports.MetadataKeySummary],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false, nil
	}
	return info, true, nil
}

// AuthStatus checks Codex's local login state without making a model call.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.codexBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(probeCtx, binary, "login", "status").CombinedOutput()
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, probeCtx.Err()
	}
	text := strings.ToLower(string(out))
	if strings.Contains(text, "not logged in") || strings.Contains(text, "logged out") {
		return ports.AgentAuthStatusUnauthorized, nil
	}
	if strings.Contains(text, "logged in") {
		return ports.AgentAuthStatusAuthorized, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnauthorized, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}

// ResolveCodexBinary returns the path to the codex binary on this machine,
// searching PATH then a handful of well-known install locations
// (Homebrew, Cargo, npm global, NVM). Returns "codex" as a last-ditch
// fallback so callers see a clear "command not found" rather than an empty
// argv.
func ResolveCodexBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"codex.exe", "codex.cmd", "codex"} {
			path, err := exec.LookPath(name)
			if err == nil && path != "" {
				return resolveNativeWindowsCodex(path), nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		candidates := []string{}
		if appData := os.Getenv("APPDATA"); appData != "" {
			shim := filepath.Join(appData, "npm", "codex.cmd")
			candidates = append(candidates, windowsNativeCodexCandidatesForShim(shim)...)
			candidates = append(candidates,
				filepath.Join(appData, "npm", "codex.exe"),
				shim,
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".cargo", "bin", "codex.exe"))
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				return resolveNativeWindowsCodex(candidate), nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		return "", fmt.Errorf("codex: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("codex"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/codex",
		"/opt/homebrew/bin/codex",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".cargo", "bin", "codex"),
			filepath.Join(home, ".npm", "bin", "codex"),
		)
		candidates = append(candidates, nvmNodeBinCandidates(home, "codex")...)
	}

	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate, nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("codex: %w", ports.ErrAgentBinaryNotFound)
}

func nvmNodeBinCandidates(home, binary string) []string {
	matches, err := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin", binary))
	if err != nil || len(matches) == 0 {
		return nil
	}
	sort.Sort(sort.Reverse(sort.StringSlice(matches)))
	return matches
}
func resolveNativeWindowsCodex(path string) string {
	if runtime.GOOS != "windows" || !strings.EqualFold(filepath.Ext(path), ".cmd") {
		return path
	}
	for _, candidate := range windowsNativeCodexCandidatesForShim(path) {
		if fileExists(candidate) {
			return candidate
		}
	}
	return path
}

func windowsNativeCodexCandidatesForShim(shim string) []string {
	dir := filepath.Dir(shim)
	return []string{
		filepath.Join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
		filepath.Join(dir, "node_modules", "@openai", "codex", "bin", "codex.exe"),
	}
}

func (p *Plugin) codexBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveCodexBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// DoctorLaunchProbes returns argv tails `ao doctor` runs against the installed
// codex binary to smoke-test the launch surface AO's hook delivery depends on.
// Probe 1 confirms --dangerously-bypass-hook-trust still exists (clap rejects
// unknown flags with a non-zero exit even alongside --version). Probe 2 loads
// codex's config with AO's `-c` session-flag overrides through the offline
// `features list` subcommand, so an override-parse regression surfaces as a
// non-zero exit or warning output. Both are built from the same flag builders
// the launch command uses, so the probes cannot drift from the real spawn argv.
func DoctorLaunchProbes() [][]string {
	flagProbe := make([]string, 0, 2)
	appendHookTrustBypassFlag(&flagProbe)
	flagProbe = append(flagProbe, "--version")

	overrideProbe := []string{"features", "list"}
	appendNoUpdateCheckFlag(&overrideProbe)
	appendHideRateLimitNudgeFlag(&overrideProbe)
	appendSessionHookFlags(&overrideProbe)
	appendWorkspaceTrustFlag(&overrideProbe, os.TempDir())
	return [][]string{flagProbe, overrideProbe}
}

func appendNoUpdateCheckFlag(cmd *[]string) {
	*cmd = append(*cmd, "-c", "check_for_update_on_startup=false")
}

func appendHideRateLimitNudgeFlag(cmd *[]string) {
	// When the account nears its rate limit, the Codex TUI interposes an
	// interactive "switch to a cheaper model?" dialog before the first turn.
	// In a headless AO pane that dialog hangs the session invisibly and
	// swallows the auto-submitted spawn prompt, so suppress it.
	*cmd = append(*cmd, "-c", "notice.hide_rate_limit_model_nudge=true")
}

func appendHookTrustBypassFlag(cmd *[]string) {
	// AO's activity hooks ride the launch command as session-flag config (see
	// appendSessionHookFlags) and carry no persisted trust hash in the user's
	// `[hooks.state]`. Without this flag Codex would hold them for an
	// interactive hooks review, leaving AO without activity signals.
	*cmd = append(*cmd, "--dangerously-bypass-hook-trust")
}

func appendTerminalCompatibilityFlags(cmd *[]string) {
	if runtime.GOOS == "windows" {
		*cmd = append(*cmd, "--no-alt-screen")
	}
}

func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch normalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// Codex sessions are AO-managed and run headlessly inside a terminal
		// mux pane; default to no approval prompts unless project settings
		// explicitly choose a more restrictive mode.
		*cmd = append(*cmd, "--dangerously-bypass-approvals-and-sandbox")
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--ask-for-approval", "on-request")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--ask-for-approval", "on-request", "-c", `approvals_reviewer="auto_review"`)
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--dangerously-bypass-approvals-and-sandbox")
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

var fileExists = func(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
