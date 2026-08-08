// Package kimchi implements the Kimchi agent adapter: launching headless Kimchi
// sessions and resuming sessions when a native session id is known.
//
// Kimchi (@kimchi-dev/cli, binary "kimchi") is a coding-agent CLI built on
// @earendil-works/pi-coding-agent. AO drives it non-interactively with
// `--print` ("process prompt and exit"). The initial prompt is delivered
// in-command as a trailing positional argument.
//
// System prompts are appended to Kimchi's default prompt via
// `--append-system-prompt <text>`. The flag takes inline text only; a
// system-prompt file is read from disk and inlined.
//
// Permissions: Kimchi accepts `--plan`, `--auto`, and `--yolo` flags for
// permission modes. AO maps its own modes onto these flags.
//
// Restore: Kimchi persists sessions and resumes by id with `--session <id>`.
// The native session id is captured from hook metadata and stored in AO's
// session metadata; GetRestoreCommand reads it back.
//
// Hooks: Kimchi has a native hook adapter that reads .kimchi/hooks.local.json.
// AO installs hooks in that file using `ao hooks kimchi <event>` commands.
// The adapter is always-on; no user configuration is needed for hooks to fire.
package kimchi

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "kimchi"

// systemPromptMaxBytes caps how many bytes readBoundedSystemPrompt will read
// from a system-prompt file. This prevents unbounded reads that could cause
// "argument list too long" errors or hang on FIFOs/slow mounts.
const systemPromptMaxBytes = 128 * 1024

// readBoundedSystemPrompt reads a system-prompt file capped at
// systemPromptMaxBytes. The file contents are returned raw (no trimming) so
// a resumed session's system prompt is byte-identical to a fresh launch.
func readBoundedSystemPrompt(path string) (string, error) {
	f, err := os.Open(path) //nolint:gosec // path is AO-owned config
	if err != nil {
		return "", fmt.Errorf("kimchi: read system prompt file: %w", err)
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, systemPromptMaxBytes+1))
	if err != nil {
		return "", fmt.Errorf("kimchi: read system prompt file: %w", err)
	}
	if len(data) > systemPromptMaxBytes {
		return "", fmt.Errorf("kimchi: system prompt file %s exceeds %d byte limit", path, systemPromptMaxBytes)
	}
	return string(data), nil
}

// Plugin implements the Kimchi agent adapter.
type Plugin struct {
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New creates a new Kimchi adapter plugin.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)

// Manifest returns the adapter's static metadata.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "Kimchi",
		Description: "Run Kimchi worker sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec returns the adapter's configuration spec (currently empty).
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to start an interactive Kimchi session
// inside a tmux pane:
//
//	kimchi [--auto|--yolo] [--append-system-prompt <text>] [<prompt>]
//
// Kimchi runs interactively (no --print): its TUI requires a TTY, which
// tmux provides. The prompt is a trailing positional argument.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	binary, err := p.kimchiBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}

	permissions := cfg.Permissions
	if permissions == "" {
		permissions = cfg.Config.Permissions
	}
	appendPermissionFlags(&cmd, permissions)
	if err := appendToolFlags(&cmd, cfg.AllowedTools, cfg.DisallowedTools); err != nil {
		return nil, err
	}

	if cfg.SystemPromptFile != "" {
		data, err := readBoundedSystemPrompt(cfg.SystemPromptFile)
		if err != nil {
			return nil, err
		}
		cmd = append(cmd, "--append-system-prompt", data)
	} else if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}
	if cfg.Prompt != "" {
		cmd = append(cmd, sanitizePrompt(cfg.Prompt))
	}
	return cmd, nil
}

// GetPromptDeliveryStrategy reports how the initial prompt is delivered to Kimchi.
func (p *Plugin) GetPromptDeliveryStrategy(ctx context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetRestoreCommand rebuilds the argv to resume an existing Kimchi session
// when a native session id is available in metadata.
//
// Final argv shape: kimchi [--auto|--yolo] [--append-system-prompt <text>] --session <id>.
// Re-applying the permission mode is a behavioral fix, not just a contract gap:
// Kimchi's default mode fails closed (cannot auto-approve anything) in headless
// contexts, so dropping the mode would regress a resumed orchestrator. The
// system prompt is re-applied because Kimchi rebuilds the prompt from the
// current flags on resume (it is not stored in the transcript), so standing
// instructions must be re-appended or a restored orchestrator loses its role.
// --session <id> is appended last. RestoreConfig does not carry
// AllowedTools/DisallowedTools, so allow/deny re-application on resume is out
// of scope.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if agentSessionID == "" {
		return nil, false, nil
	}

	binary, err := p.kimchiBinary(ctx)
	if err != nil {
		return nil, false, err
	}
	cmd = []string{binary}
	appendPermissionFlags(&cmd, cfg.Permissions)

	systemPrompt, err := resolveRestoreSystemPrompt(cfg)
	if err != nil {
		return nil, false, err
	}
	if systemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", systemPrompt)
	}

	cmd = append(cmd, "--session", agentSessionID)
	return cmd, true, nil
}

// SessionInfo surfaces the normalized session metadata that the hooks
// persisted: native session id, title, and summary.
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

// appendToolFlags emits at most one --allow-tool and at most one --deny-tool
// flag for a tool-scoped launch. All allowed rules are comma-joined into a
// single --allow-tool value, and all disallowed rules into a single --deny-tool
// value. Empty lists emit nothing, so an unrestricted launch is unchanged.
//
// Kimchi's permission loader splits the flag value by comma (splitFlag), and
// repeated flags overwrite (last-wins), so emitting one pair per rule would
// collapse the deny list to a single entry — silently breaking the reviewer's
// read-only guarantee. Comma-joining into a single value ensures every rule
// survives the split. Kimchi's --allow-tool/--deny-tool flags accept the same
// rule syntax as Claude Code (bash(git diff:*), edit, mcp__server__tool), and
// the rule parser is case-insensitive on tool names, so lowercase tool names
// are used to match Kimchi's internal names. These rules are honored under
// --auto and --plan; only --dangerously-skip-permissions (not mapped by AO)
// would skip the denylist.
func appendToolFlags(cmd *[]string, allowed, disallowed []string) error {
	for _, rule := range allowed {
		if strings.Contains(rule, ",") {
			return fmt.Errorf("kimchi: allowed tool rule %q contains a comma; tool rules are comma-joined into a single flag value so a literal comma would silently split the rule", rule)
		}
	}
	for _, rule := range disallowed {
		if strings.Contains(rule, ",") {
			return fmt.Errorf("kimchi: disallowed tool rule %q contains a comma; tool rules are comma-joined into a single flag value so a literal comma would silently split the rule", rule)
		}
	}
	if len(allowed) > 0 {
		*cmd = append(*cmd, "--allow-tool", strings.Join(allowed, ","))
	}
	if len(disallowed) > 0 {
		*cmd = append(*cmd, "--deny-tool", strings.Join(disallowed, ","))
	}
	return nil
}

func appendPermissionFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch permissions {
	case ports.PermissionModeDefault, "":
		// No flag: use Kimchi's default behavior.
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--auto")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--yolo")
	}
}

// kimchiSubcommands is the set of Kimchi CLI subcommand names. A worker
// prompt that exactly matches one of these would be interpreted as
// subcommand dispatch rather than task text, so sanitizePrompt neutralizes
// it with a leading newline.
var kimchiSubcommands = map[string]bool{
	"setup":       true,
	"login":       true,
	"setup-tools": true,
	"claude":      true,
	"opencode":    true,
	"cursor":      true,
	"openclaw":    true,
	"gsd2":        true,
	"update":      true,
	"config":      true,
	"resources":   true,
	"version":     true,
}

// sanitizePrompt prevents a worker prompt from being parsed as a Kimchi flag
// (leading '-'), file reference (leading '@'), or subcommand dispatch (exact
// match against a known subcommand name). When any of those conditions hold,
// a leading '\n' is prepended. The newline is invisible to the model and
// ensures the argument is treated as positional task text, not a flag, file
// reference, or subcommand. Normal prompts are passed through unchanged,
// preserving the existing PromptDeliveryInCommand strategy.
func sanitizePrompt(prompt string) string {
	if prompt == "" {
		return prompt
	}
	if strings.HasPrefix(prompt, "-") || strings.HasPrefix(prompt, "@") || kimchiSubcommands[prompt] {
		return "\n" + prompt
	}
	return prompt
}

// resolveRestoreSystemPrompt returns the system prompt text to re-append on
// resume. It mirrors the launch-side precedence of GetLaunchCommand: a
// cfg.SystemPromptFile is read from disk and inlined when set, else
// cfg.SystemPrompt is used inline. A file-read error is returned rather than
// silently dropping the prompt, so a resumed orchestrator cannot lose its
// standing instructions without the caller knowing.
func resolveRestoreSystemPrompt(cfg ports.RestoreConfig) (string, error) {
	if cfg.SystemPromptFile != "" {
		return readBoundedSystemPrompt(cfg.SystemPromptFile)
	}
	return cfg.SystemPrompt, nil
}

var kimchiBinarySpec = binaryutil.BinarySpec{
	Label:         "kimchi",
	Names:         []string{"kimchi"},
	WinNames:      []string{"kimchi.cmd", "kimchi.exe", "kimchi"},
	UnixPaths:     []string{"/usr/local/bin/kimchi", "/opt/homebrew/bin/kimchi"},
	UnixHomePaths: binaryutil.NodeManagedUnixHomePaths("kimchi"),
	NodeManaged:   true,
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "kimchi.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "kimchi.exe"}},
	},
}

// ResolveKimchiBinary locates the kimchi executable on the system.
func ResolveKimchiBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, kimchiBinarySpec)
}

func (p *Plugin) kimchiBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveKimchiBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}
