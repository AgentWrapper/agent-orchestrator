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
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Plugin is the Codex agent adapter. It is safe for concurrent use; the binary
// path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	manifestID          string
	manifestName        string
	manifestDescription string
	binaryName          string
	hookAgentToken      string
	binaryMu            sync.Mutex
	resolvedBinary      string
}

// New returns a ready-to-register Codex adapter.
func New() *Plugin {
	return &Plugin{}
}

// NewFugu returns a Codex-compatible adapter that launches the codex-fugu
// binary while preserving Codex's flags, hooks, auth probe, and activity model.
func NewFugu() *Plugin {
	return &Plugin{
		manifestID:          "codex-fugu",
		manifestName:        "Codex Fugu",
		manifestDescription: "Run Codex Fugu worker sessions.",
		binaryName:          "codex-fugu",
		hookAgentToken:      "codex-fugu",
	}
}

// EmitsSubmitActivity signals Codex fires a user-prompt-submit hook under AO's
// launch. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

// EmitsBlockedActivity reports that this harness signals a permission/
// approval pause (blocked), so AO can tell a pending decision from an
// unsubmitted draft. See ports.ActivitySignaler.
func (p *Plugin) EmitsBlockedActivity() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)
var _ ports.AgentAuthChecker = (*Plugin)(nil)
var _ ports.AgentModelValidator = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          p.adapterID(),
		Name:        p.adapterName(),
		Description: p.adapterDescription(),
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetLaunchCommand builds the argv to start a new Codex session, applying the
// no-update-check, hook-trust bypass, and approval flags, AO's session-flag
// activity hooks, the workspace trust override, optional system-prompt
// instructions, and the initial prompt (passed after `--` so a leading "-" is
// not read as a flag).
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.agentBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	p.appendWrapperFlags(&cmd)
	appendNoUpdateCheckFlag(&cmd)
	appendHideRateLimitNudgeFlag(&cmd)
	appendHookTrustBypassFlag(&cmd)
	appendApprovalFlags(&cmd, cfg.Permissions)
	appendSessionHookFlagsFor(&cmd, p.hookToken())
	appendTerminalCompatibilityFlags(&cmd)
	appendWorkspaceTrustFlag(&cmd, cfg.WorkspacePath)
	if model := strings.TrimSpace(cfg.Config.Model); model != "" {
		cmd = append(cmd, "--model", model)
	}
	appendReasoningEffortFlag(&cmd, string(cfg.Config.Effort))

	if cfg.SystemPromptFile != "" {
		cmd = append(cmd, "-c", "model_instructions_file="+cfg.SystemPromptFile)
	} else if cfg.SystemPrompt != "" {
		cmd = append(cmd, "-c", "developer_instructions="+codexTOMLConfigString(cfg.SystemPrompt))
	}

	if command, ok := p.InHarnessTitleCommand(cfg.LaunchTitle); ok {
		cmd = append(cmd, "--", command)
	} else if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy sends the real prompt after startup when the argv
// prompt slot is used for AO's launch-time title command.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if command, ok := p.InHarnessTitleCommand(cfg.LaunchTitle); ok && command != "" && cfg.Prompt != "" {
		return ports.PromptDeliveryAfterStart, nil
	}
	return ports.PromptDeliveryInCommand, nil
}

// InHarnessTitleCommand returns the Codex slash command that renames the active
// native session title.
func (p *Plugin) InHarnessTitleCommand(title string) (string, bool) {
	title = strings.Join(strings.Fields(domain.SanitizeControlChars(title)), " ")
	if title == "" {
		return "", false
	}
	return "/rename " + title, true
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

	binary, err := p.agentBinary(ctx)
	if err != nil {
		return nil, false, err
	}

	cmd = make([]string, 0, 25)
	cmd = append(cmd, binary)
	p.appendWrapperFlags(&cmd)
	cmd = append(cmd, "resume")
	appendNoUpdateCheckFlag(&cmd)
	appendHideRateLimitNudgeFlag(&cmd)
	appendHookTrustBypassFlag(&cmd)
	appendApprovalFlags(&cmd, cfg.Permissions)
	appendSessionHookFlagsFor(&cmd, p.hookToken())
	appendTerminalCompatibilityFlags(&cmd)
	appendWorkspaceTrustFlag(&cmd, cfg.Session.WorkspacePath)
	if model := strings.TrimSpace(cfg.Config.Model); model != "" {
		cmd = append(cmd, "--model", model)
	}
	appendReasoningEffortFlag(&cmd, string(cfg.Config.Effort))
	cmd = append(cmd, agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces Codex hook-derived metadata. Metadata is intentionally
// nil for Codex: callers get the normalized fields directly.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// AuthStatus checks Codex's local login state without making a model call.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.agentBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	status, text, cmdErr, err := loginStatusForBinary(ctx, binary)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	if p.adapterID() == "codex-fugu" && cmdErr != nil && strings.Contains(text, "--profile only applies") {
		return fuguSharedCodexAuthStatus(ctx)
	}
	if cmdErr != nil {
		return ports.AgentAuthStatusUnauthorized, cmdErr
	}
	return ports.AgentAuthStatusUnknown, nil
}

// ValidateModel performs a bounded non-interactive Codex call with the requested
// model. This catches account/provider rejections that namespace validation
// cannot know about, before a worker-mix bucket is stored.
func (p *Plugin) ValidateModel(ctx context.Context, model string) error {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	binary, err := p.agentBinary(ctx)
	if err != nil {
		return err
	}
	args := make([]string, 0, 16)
	p.appendWrapperFlags(&args)
	args = append(args,
		"exec",
		"--model", model,
		"--sandbox", "read-only",
		"--ask-for-approval", "never",
		"--skip-git-repo-check",
		"--ephemeral",
		"--ignore-rules",
		"--color", "never",
		"Reply exactly OK. Do not use tools.",
	)
	out, err := exec.CommandContext(ctx, binary, args...).CombinedOutput()
	if ctx.Err() != nil {
		return fmt.Errorf("model probe timed out: %w", ctx.Err())
	}
	if err != nil {
		return fmt.Errorf("model probe failed: %w%s", err, formatProbeOutput(out))
	}
	return nil
}

func formatProbeOutput(out []byte) string {
	text := strings.TrimSpace(string(out))
	if text == "" {
		return ""
	}
	if len(text) > 500 {
		text = text[:500] + "...[truncated]"
	}
	return ": " + text
}

func (p *Plugin) appendWrapperFlags(cmd *[]string) {
	if p.adapterID() == "codex-fugu" {
		*cmd = append(*cmd, "--no-update")
	}
}

func loginStatusForBinary(ctx context.Context, binary string) (ports.AgentAuthStatus, string, error, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(probeCtx, binary, "login", "status").CombinedOutput()
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, "", err, probeCtx.Err()
	}
	text := strings.ToLower(string(out))
	if strings.Contains(text, "not logged in") || strings.Contains(text, "logged out") {
		return ports.AgentAuthStatusUnauthorized, text, err, nil
	}
	if strings.Contains(text, "logged in") {
		return ports.AgentAuthStatusAuthorized, text, err, nil
	}
	return ports.AgentAuthStatusUnknown, text, err, nil
}

func fuguSharedCodexAuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	codexBinary, err := ResolveCodexBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	status, _, cmdErr, err := loginStatusForBinary(ctx, codexBinary)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	if cmdErr != nil {
		return ports.AgentAuthStatusUnauthorized, cmdErr
	}
	return ports.AgentAuthStatusUnknown, nil
}

// ResolveCodexBinary returns the path to the codex binary on this machine,
// searching PATH then a handful of well-known install locations
// (Homebrew, Cargo, npm global, NVM). Returns "codex" as a last-ditch
// fallback so callers see a clear "command not found" rather than an empty
// argv.
func ResolveCodexBinary(ctx context.Context) (string, error) {
	return ResolveAgentBinary(ctx, "codex")
}

// ResolveAgentBinary returns the path to the requested Codex-family binary on
// this machine, searching PATH then common install locations.
func ResolveAgentBinary(ctx context.Context, binaryName string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	binaryName = strings.TrimSpace(binaryName)
	if binaryName == "" {
		binaryName = "codex"
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{binaryName + ".exe", binaryName + ".cmd", binaryName} {
			path, err := exec.LookPath(name)
			if err == nil && path != "" {
				if binaryName == "codex" {
					return resolveNativeWindowsCodex(path), nil
				}
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		candidates := []string{}
		if appData := os.Getenv("APPDATA"); appData != "" {
			shim := filepath.Join(appData, "npm", binaryName+".cmd")
			if binaryName == "codex" {
				candidates = append(candidates, windowsNativeCodexCandidatesForShim(shim)...)
			}
			candidates = append(candidates,
				filepath.Join(appData, "npm", binaryName+".exe"),
				shim,
			)
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".cargo", "bin", binaryName+".exe"))
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				if binaryName == "codex" {
					return resolveNativeWindowsCodex(candidate), nil
				}
				return candidate, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}

		return "", fmt.Errorf("%s: %w", binaryName, ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath(binaryName); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		filepath.Join(string(filepath.Separator), "usr", "local", "bin", binaryName),
		filepath.Join(string(filepath.Separator), "opt", "homebrew", "bin", binaryName),
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".cargo", "bin", binaryName),
			filepath.Join(home, ".npm", "bin", binaryName),
		)
		candidates = append(candidates, nvmNodeBinCandidates(home, binaryName)...)
	}

	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate, nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("%s: %w", binaryName, ports.ErrAgentBinaryNotFound)
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

func (p *Plugin) agentBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveAgentBinary(ctx, p.binaryCommand())
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

func (p *Plugin) adapterID() string {
	if p.manifestID != "" {
		return p.manifestID
	}
	return "codex"
}

func (p *Plugin) adapterName() string {
	if p.manifestName != "" {
		return p.manifestName
	}
	return "Codex"
}

func (p *Plugin) adapterDescription() string {
	if p.manifestDescription != "" {
		return p.manifestDescription
	}
	return "Run Codex worker sessions."
}

func (p *Plugin) binaryCommand() string {
	if p.binaryName != "" {
		return p.binaryName
	}
	return "codex"
}

func (p *Plugin) hookToken() string {
	if p.hookAgentToken != "" {
		return p.hookAgentToken
	}
	return "codex"
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

// appendReasoningEffortFlag maps AO's effort level onto Codex's
// model_reasoning_effort config override. Empty means unset — Codex keeps its
// own default. The value is emitted as a quoted TOML string so `-c` parses it
// as the reasoning-effort enum.
func appendReasoningEffortFlag(cmd *[]string, effort string) {
	if e := normalizeCodexEffort(effort); e != "" {
		*cmd = append(*cmd, "-c", fmt.Sprintf("model_reasoning_effort=%q", e))
	}
}

// normalizeCodexEffort maps AO's union effort vocabulary onto the levels Codex
// accepts (minimal|low|medium|high). AO's higher tiers (xhigh|max) clamp to
// high so a valid stored config never emits an effort flag Codex would reject
// and hang on — the same "provider-mismatched input must not silently hang"
// contract this package enforces for models. Empty/unknown yields "".
func normalizeCodexEffort(effort string) string {
	switch e := strings.ToLower(strings.TrimSpace(effort)); e {
	case "minimal", "low", "medium", "high":
		return e
	case "xhigh", "max":
		return "high"
	default:
		return ""
	}
}

func appendTerminalCompatibilityFlags(cmd *[]string) {
	if runtime.GOOS == "windows" {
		*cmd = append(*cmd, "--no-alt-screen")
	}
}

func appendApprovalFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
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

// fileExists is a package var so tests can stub it to scope candidate probing.
var fileExists = func(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
