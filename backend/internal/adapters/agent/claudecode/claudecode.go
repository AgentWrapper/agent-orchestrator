// Package claudecode implements the Claude Code agent adapter.
//
// It builds the argv to launch `claude` as an interactive session inside a
// session's worktree, installs worktree-local hooks that report normalized
// session metadata (native id, title, summary) back into AO's store,
// and supports resume: GetLaunchCommand pins a stable `--session-id` so
// GetRestoreCommand can rebuild `claude --resume <uuid>`. SessionInfo reads the
// hook-captured metadata from the store — it does not parse transcripts.
// GetConfigSpec remains a no-op (no agent-specific config keys yet).
//
// Claude Code starts an interactive session by default (no -p/--print), which
// is exactly what AO wants: a live agent the user can attach to in the
// browser terminal or via `tmux attach`. The initial task prompt is passed
// as the positional argument; the orchestrator system prompt (if any) is
// appended to Claude's default system prompt so its built-in coding
// instructions are preserved.
package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// adapterID is the registry id and the value users pass to
	// `ao spawn --agent`.
	adapterID = "claude-code"
)

// claudeSessionNamespace seeds the UUIDv5 derivation that maps an AO
// session id onto a stable Claude Code `--session-id`. A fixed namespace makes
// the mapping deterministic, so GetLaunchCommand (which pins --session-id at
// launch) and GetRestoreCommand (which recomputes it as a fallback for
// pre-hook sessions) agree without persisting anything.
var claudeSessionNamespace = uuid.MustParse("a1f0c3d2-7b54-4e96-8a2b-0d9e1f2a3b4c")

// Plugin is the Claude Code agent adapter. It is safe for concurrent use; the
// binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register Claude Code adapter.
func New() *Plugin {
	return &Plugin{}
}

// EmitsSubmitActivity signals that Claude Code fires a user-prompt-submit hook
// under AO's launch, so Activity.State can flip to active after a prompt is
// accepted. See ports.ActivitySignaler.
func (p *Plugin) EmitsSubmitActivity() bool { return true }

// EmitsBlockedActivity reports that this harness signals a permission/
// approval pause (blocked), so AO can tell a pending decision from an
// unsubmitted draft. See ports.ActivitySignaler.
func (p *Plugin) EmitsBlockedActivity() bool { return true }

// RequireHookParentPID reports that Claude Code runs AO hook commands directly
// enough for the tmux runtime's parent-PID lineage marker to guard callbacks.
func (p *Plugin) RequireHookParentPID() bool { return true }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)
var _ ports.AgentAuthChecker = (*Plugin)(nil)
var _ ports.AgentModelValidator = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Claude Code",
		Description: "Run Claude Code worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// permissionConfigEnum lists the permission modes the "permissions" config key
// accepts. It mirrors the ports.PermissionMode constants so a project's stored
// config validates against the same vocabulary the launch command maps.
var permissionConfigEnum = []string{
	string(ports.PermissionModeDefault),
	string(ports.PermissionModeAcceptEdits),
	string(ports.PermissionModeAuto),
	string(ports.PermissionModeBypassPermissions),
}

// GetConfigSpec reports the per-project agent config keys Claude Code
// understands: a model override and a starting permission mode.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{
		Fields: []ports.ConfigField{
			{
				Key:         "model",
				Type:        ports.ConfigFieldString,
				Description: "Model override passed to `claude --model` (e.g. claude-opus-4-5).",
			},
			{
				Key:         "effort",
				Type:        ports.ConfigFieldEnum,
				Description: "Reasoning-effort level passed to `claude --effort`.",
				Enum:        []string{"low", "medium", "high", "xhigh", "max"},
			},
			{
				Key:         "permissions",
				Type:        ports.ConfigFieldEnum,
				Description: "Starting permission mode.",
				Enum:        permissionConfigEnum,
			},
		},
	}, nil
}

// GetLaunchCommand builds the argv to start an interactive Claude Code
// session. Shape:
//
//	claude [--session-id <uuid>] \
//	       [--permission-mode <mode>] \
//	       [--append-system-prompt <system prompt>] \
//	       [-- <prompt>]
//
// --session-id pins Claude's native session UUID to a value derived from the
// AO session id, so the session is resumable later (see
// GetRestoreCommand) and its transcript is locatable (see SessionInfo) without
// a separate capture step.
//
// <mode> is acceptEdits, auto, or bypassPermissions. AO's "default"
// mode emits no --permission-mode flag, so Claude's TUI resolves the starting
// mode from ~/.claude/settings.json exactly as a normal launch.
//
// The prompt is passed after `--` so a prompt beginning with "-" is not
// mistaken for a flag.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	// Defense-in-depth: the project service validates on write, but re-check
	// here so a config written by any other path can't launch a bad command.
	if err := cfg.Config.Validate(); err != nil {
		return nil, fmt.Errorf("claude-code: %w", err)
	}

	binary, err := p.claudeBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	if cfg.SessionID != "" {
		cmd = append(cmd, "--session-id", claudeSessionUUID(cfg.SessionID))
	}
	// A project's configured permissions drive the starting mode; the explicit
	// LaunchConfig.Permissions wins when set so a per-spawn override still takes
	// precedence over the stored project default.
	permissions := cfg.Permissions
	if permissions == "" {
		permissions = cfg.Config.Permissions
	}
	appendPermissionFlags(&cmd, permissions)
	appendToolFlags(&cmd, cfg.AllowedTools, cfg.DisallowedTools)

	if model := strings.TrimSpace(cfg.Config.Model); model != "" {
		cmd = append(cmd, "--model", model)
	}
	if effort := normalizeClaudeEffort(string(cfg.Config.Effort)); effort != "" {
		cmd = append(cmd, "--effort", effort)
	}

	systemPrompt, err := resolveSystemPrompt(cfg)
	if err != nil {
		return nil, err
	}
	if systemPrompt != "" {
		// Append rather than replace: Claude Code's default system prompt
		// carries its tool-use and coding instructions, which we want to
		// keep. The orchestrator prompt layers on top.
		cmd = append(cmd, "--append-system-prompt", systemPrompt)
	}

	// Claude Code has exactly one startup slot. It belongs to the prompt: the
	// prompt is the session's whole purpose, and argv delivery is atomic. The
	// launch title goes in via the in-harness `/rename` after the TUI is up
	// (see AgentTitleCommander), where a dropped write costs only a name.
	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}

	return cmd, nil
}

// GetPromptDeliveryStrategy reports how AO should deliver the initial task.
// Always in the launch command: nothing else competes for the startup slot.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// InHarnessTitleCommand returns the Claude Code slash command that renames the
// active native session title.
func (p *Plugin) InHarnessTitleCommand(title string) (string, bool) {
	title = claudeLaunchTitle(title)
	if title == "" {
		return "", false
	}
	return "/rename " + title, true
}

// PreLaunch is an optional capability the spawn engine invokes (via type
// assertion) immediately before creating the session. Claude Code shows a
// blocking "do you trust this folder?" dialog the first time it runs in any
// directory. Every AO worktree is a fresh path, so without this the
// agent would hang at that prompt with no one to answer it.
//
// An AO worktree is derived from the repo the user is already running
// AO in, so it is inherently trusted. PreLaunch records that trust in
// ~/.claude.json before launch, additively and atomically, so it cannot
// clobber a concurrently-running Claude instance's config.
func (p *Plugin) PreLaunch(ctx context.Context, cfg ports.LaunchConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if cfg.WorkspacePath == "" {
		return nil
	}
	cfgPath, err := claudeConfigPath()
	if err != nil {
		return err
	}
	return ensureWorkspaceTrusted(cfgPath, cfg.WorkspacePath)
}

// GetRestoreCommand rebuilds the argv that continues an existing Claude Code
// session: `claude [--permission-mode <mode>] --resume <agentSessionId>`. It
// prefers the hook-captured native session id from
// cfg.Session.Metadata["agentSessionId"]; for sessions created before hooks
// captured it, it falls back to the deterministic UUID AO pins via
// --session-id at launch. ok is false only when neither is available, so the
// caller fresh-spawns. The command re-applies the permission mode (resume
// otherwise reverts to the configured default) but not the prompt/system
// prompt, which the session already carries.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}

	sessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if sessionID == "" && cfg.Session.ID != "" {
		// Explicit fallback for pre-hook sessions: the id AO
		// deterministically pinned via --session-id at launch.
		sessionID = claudeSessionUUID(cfg.Session.ID)
	}
	if sessionID == "" {
		return nil, false, nil
	}

	binary, err := p.claudeBinary(ctx)
	if err != nil {
		return nil, false, err
	}
	cmd = make([]string, 0, 7)
	cmd = append(cmd, binary)
	appendPermissionFlags(&cmd, cfg.Permissions)
	if cfg.SystemPrompt != "" {
		// --resume rebuilds the system prompt from the current flags (it is
		// not stored in the transcript), so standing instructions must be
		// re-appended or a restored orchestrator loses its role.
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}
	if model := strings.TrimSpace(cfg.Config.Model); model != "" {
		cmd = append(cmd, "--model", model)
	}
	if effort := normalizeClaudeEffort(string(cfg.Config.Effort)); effort != "" {
		cmd = append(cmd, "--effort", effort)
	}
	cmd = append(cmd, "--resume", sessionID)
	return cmd, true, nil
}

// SessionInfo surfaces the normalized session metadata that the Claude Code
// hooks persisted into AO's store: the native session id, the title (the
// first user prompt), and the summary (the final assistant message). It reads
// only from session.Metadata — never from transcript files — and returns
// ok=false when none of those fields are present. Metadata is intentionally nil:
// there is no Claude-specific field callers need beyond the normalized ones.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// AuthStatus checks Claude Code's local authentication state without starting a
// session.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.claudeBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := claudeLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(probeCtx, binary, "auth", "status").CombinedOutput()
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, probeCtx.Err()
	}
	if status, ok := claudeAuthStatusFromOutput(out); ok {
		return status, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnauthorized, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}

const claudeProbeWaitDelay = 2 * time.Second

func (p *Plugin) probeArgs(model string) []string {
	return []string{
		"--print",
		"--model", model,
		"--permission-mode", "dontAsk",
		"--no-session-persistence",
		"--strict-mcp-config",
		"--mcp-config", "{}",
		"--disallowedTools", "Task,Bash,Edit,MultiEdit,Write,Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,NotebookEdit",
		"Reply exactly OK. Do not use tools.",
	}
}

// ValidateModel performs a bounded non-interactive Claude Code call with the
// requested model. Only an explicit model/provider rejection is a hard verdict;
// startup, usage, timeout, auth, network, and other non-verdict failures are
// ProbeUnavailable so config writes remain fail-open.
func (p *Plugin) ValidateModel(ctx context.Context, model string) error {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	binary, err := p.claudeBinary(ctx)
	if err != nil {
		return &ports.ProbeUnavailableError{Reason: "claude binary not resolvable", Err: err}
	}
	cmd := exec.CommandContext(ctx, binary, p.probeArgs(model)...)
	cmd.WaitDelay = claudeProbeWaitDelay
	configureProbeProcessGroup(cmd)
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return &ports.ProbeUnavailableError{Reason: "model probe timed out", Err: ctx.Err()}
	}
	if err == nil {
		return nil
	}
	if unavailable := classifyClaudeProbeFailure(err, out); unavailable != nil {
		return unavailable
	}
	return fmt.Errorf("model probe failed: %w%s", err, formatClaudeProbeOutput(out))
}

func classifyClaudeProbeFailure(err error, out []byte) *ports.ProbeUnavailableError {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return &ports.ProbeUnavailableError{Reason: "claude probe did not start", Err: err}
	}
	if exitErr.ExitCode() < 0 {
		return &ports.ProbeUnavailableError{Reason: "claude probe was killed by a signal", Err: err}
	}
	if !claudeProbeSawModelRejection(out) {
		return &ports.ProbeUnavailableError{
			Reason: "claude probe failed without a provider verdict on the model" + formatClaudeProbeOutput(out),
			Err:    err,
		}
	}
	return nil
}

var (
	claudeProbeStatusJSONRe  = regexp.MustCompile(`"status"\s*:\s*(\d{3})`)
	claudeProbeStatusPlainRe = regexp.MustCompile(`(?im)^\s*(?:api\s+)?error:\s*(\d{3})\b`)
)

func claudeProbeSawModelRejection(out []byte) bool {
	text := string(out)
	statuses := make([]int, 0, 4)
	for _, re := range []*regexp.Regexp{claudeProbeStatusJSONRe, claudeProbeStatusPlainRe} {
		for _, m := range re.FindAllStringSubmatch(text, -1) {
			if code, err := strconv.Atoi(m[1]); err == nil {
				statuses = append(statuses, code)
			}
		}
	}
	rejected := false
	for _, code := range statuses {
		switch {
		case code >= 500, code == 429, code == 408:
			return false
		case code == 400, code == 404, code == 422:
			rejected = true
		}
	}
	return rejected
}

func formatClaudeProbeOutput(out []byte) string {
	text := strings.TrimSpace(string(out))
	if text == "" {
		return ""
	}
	const maxProbeOutputRunes = 500
	runes := []rune(text)
	if len(runes) > maxProbeOutputRunes {
		text = string(runes[:maxProbeOutputRunes]) + "...[truncated]"
	}
	return ": " + text
}

func claudeAuthStatusFromOutput(out []byte) (ports.AgentAuthStatus, bool) {
	start := bytes.IndexByte(out, '{')
	end := bytes.LastIndexByte(out, '}')
	if start < 0 || end < start {
		return ports.AgentAuthStatusUnknown, false
	}
	var status struct {
		LoggedIn bool `json:"loggedIn"`
	}
	if json.Unmarshal(out[start:end+1], &status) != nil {
		return ports.AgentAuthStatusUnknown, false
	}
	if status.LoggedIn {
		return ports.AgentAuthStatusAuthorized, true
	}
	return ports.AgentAuthStatusUnauthorized, true
}

func claudeLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	cfgPath, err := claudeConfigPath()
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	return claudeConfigAuthStatus(cfgPath)
}

func claudeConfigAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	var hasSubscription bool
	if raw := root["hasAvailableSubscription"]; len(raw) > 0 {
		_ = json.Unmarshal(raw, &hasSubscription)
	}
	var userID string
	if raw := root["userID"]; len(raw) > 0 {
		_ = json.Unmarshal(raw, &userID)
	}
	if strings.TrimSpace(userID) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	var oauthAccount map[string]any
	if raw := root["oauthAccount"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &oauthAccount); err != nil {
			return ports.AgentAuthStatusUnknown, false, err
		}
	}
	if len(oauthAccount) == 0 {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if hasSubscription {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	if accountUUID, ok := oauthAccount["accountUuid"].(string); ok && strings.TrimSpace(accountUUID) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

// claudeSessionUUID maps an AO session id onto a stable Claude Code
// session UUID via UUIDv5 over a fixed namespace, so the same AO session
// always resolves to the same Claude session.
func claudeSessionUUID(aoSessionID string) string {
	return uuid.NewSHA1(claudeSessionNamespace, []byte(aoSessionID)).String()
}

// resolveSystemPrompt returns the system prompt text to append, preferring
// SystemPromptFile (read from disk) over an inline SystemPrompt.
func resolveSystemPrompt(cfg ports.LaunchConfig) (string, error) {
	if cfg.SystemPromptFile != "" {
		data, err := os.ReadFile(cfg.SystemPromptFile)
		if err != nil {
			return "", fmt.Errorf("claude-code: read system prompt file: %w", err)
		}
		return strings.TrimRight(string(data), "\n"), nil
	}
	return cfg.SystemPrompt, nil
}

func claudeLaunchTitle(title string) string {
	withoutControls := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, title)
	return strings.Join(strings.Fields(withoutControls), " ")
}

// appendPermissionFlags maps AO's permission modes onto Claude Code's
// --permission-mode values:
//   - default            → no flag. Claude's TUI resolves the starting mode
//     from ~/.claude/settings.json (defaultMode), exactly as a normal launch.
//   - accept-edits       → --permission-mode acceptEdits (auto-accept edits +
//     safe filesystem bash; still prompts for network/system bash, MCP, web)
//   - auto               → --permission-mode auto (classifier-gated
//     auto-approval; auto-runs what a safety model deems safe)
//   - bypass-permissions → --permission-mode bypassPermissions (skip all
//     checks; equivalent to --dangerously-skip-permissions)
//
// Empty/unrecognized normalizes to default, so no flag is emitted.
func appendPermissionFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
	case ports.PermissionModeDefault:
		// No flag: defer to the user's settings.json defaultMode.
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--permission-mode", "acceptEdits")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--permission-mode", "auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--permission-mode", "bypassPermissions")
	}
}

// appendToolFlags emits --allowedTools / --disallowedTools for a tool-scoped
// launch. Each list is joined with commas into one value so rules that contain
// spaces (e.g. "Bash(git diff:*)") are not split into separate tool names.
// Empty lists emit nothing, so an unrestricted launch is unchanged. These rules
// only bite when the launch is off bypassPermissions, which ignores them.
func appendToolFlags(cmd *[]string, allowed, disallowed []string) {
	if len(allowed) > 0 {
		*cmd = append(*cmd, "--allowedTools", strings.Join(allowed, ","))
	}
	if len(disallowed) > 0 {
		*cmd = append(*cmd, "--disallowedTools", strings.Join(disallowed, ","))
	}
}

// normalizeClaudeEffort maps AO's union effort vocabulary onto the levels
// `claude --effort` accepts (low|medium|high|xhigh|max). AO's "minimal" (a
// Codex-only tier) clamps to "low" so a valid stored config never emits an
// effort flag Claude would reject. Empty/unknown yields "".
func normalizeClaudeEffort(effort string) string {
	switch e := strings.ToLower(strings.TrimSpace(effort)); e {
	case "low", "medium", "high", "xhigh", "max":
		return e
	case "minimal":
		return "low"
	default:
		return ""
	}
}

// claudeBinarySpec locates the claude binary: PATH first, then the native
// installer's locations, npm global, Homebrew, and the claude-managed dir.
var claudeBinarySpec = binaryutil.BinarySpec{
	Label:         "claude",
	Names:         []string{"claude"},
	WinNames:      []string{"claude.cmd", "claude.exe", "claude"},
	UnixPaths:     []string{"/usr/local/bin/claude", "/opt/homebrew/bin/claude"},
	UnixHomePaths: [][]string{{".local", "bin", "claude"}, {".npm", "bin", "claude"}, {".claude", "local", "claude"}},
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "claude.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "claude.exe"}},
	},
}

// ResolveClaudeBinary returns the path to the claude binary, or a wrapped
// ports.ErrAgentBinaryNotFound when it is absent.
func ResolveClaudeBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, claudeBinarySpec)
}

func (p *Plugin) claudeBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveClaudeBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

// claudeConfigPath returns the path to Claude Code's global config file,
// ~/.claude.json.
func claudeConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("claude-code: resolve home directory: %w", err)
	}
	return filepath.Join(home, ".claude.json"), nil
}

// ensureWorkspaceTrusted records workspacePath as trusted in Claude Code's
// config so the interactive trust dialog does not block a spawned session.
//
// It is additive and concurrency-safe: it reads the existing config, sets
// only projects[workspacePath].hasTrustDialogAccepted = true (preserving the
// rest of the entry and every other project), and writes back via a
// temp-file + atomic rename. If the path is already trusted, it makes no
// write at all. A missing config file is treated as an empty one.
// claudeTrustMu serializes ensureWorkspaceTrusted within the process. Concurrent
// spawns to different workspaces otherwise read the same ~/.claude.json snapshot
// and the last rename drops the other's trust entry.
var claudeTrustMu sync.Mutex

func ensureWorkspaceTrusted(configPath, workspacePath string) error {
	claudeTrustMu.Lock()
	defer claudeTrustMu.Unlock()

	root := map[string]any{}
	data, err := os.ReadFile(configPath)
	switch {
	case err == nil:
		if len(data) > 0 {
			if err := json.Unmarshal(data, &root); err != nil {
				return fmt.Errorf("claude-code: parse %s: %w", configPath, err)
			}
		}
	case os.IsNotExist(err):
		// Treat as empty config; we'll create it.
	default:
		return fmt.Errorf("claude-code: read %s: %w", configPath, err)
	}

	projects, _ := root["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
		root["projects"] = projects
	}

	entry, _ := projects[workspacePath].(map[string]any)
	if entry == nil {
		entry = map[string]any{}
		projects[workspacePath] = entry
	}

	if trusted, ok := entry["hasTrustDialogAccepted"].(bool); ok && trusted {
		// Already trusted — no write needed, so no race window at all.
		return nil
	}
	entry["hasTrustDialogAccepted"] = true

	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return fmt.Errorf("claude-code: encode %s: %w", configPath, err)
	}

	// Atomic write: temp file in the same directory, then rename. Matches
	// how Claude Code itself updates this file, so concurrent updates are
	// last-writer-wins rather than corrupting.
	dir := filepath.Dir(configPath)
	tmp, err := os.CreateTemp(dir, ".claude.json.tmp-*")
	if err != nil {
		return fmt.Errorf("claude-code: create temp config: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once renamed

	if _, err := tmp.Write(out); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("claude-code: write temp config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("claude-code: close temp config: %w", err)
	}
	if err := os.Rename(tmpName, configPath); err != nil {
		return fmt.Errorf("claude-code: replace config: %w", err)
	}
	return nil
}
