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
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const adapterID = "kimchi"

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

	if cfg.SystemPromptFile != "" {
		data, err := os.ReadFile(cfg.SystemPromptFile) //nolint:gosec // path is AO-owned launch config
		if err != nil {
			return nil, err
		}
		cmd = append(cmd, "--append-system-prompt", string(data))
	} else if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}
	if cfg.Prompt != "" {
		cmd = append(cmd, cfg.Prompt)
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
	cmd = []string{binary, "--session", agentSessionID}
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

// ResolveKimchiBinary locates the kimchi executable on the system.
func ResolveKimchiBinary(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		for _, name := range []string{"kimchi.cmd", "kimchi.exe", "kimchi"} {
			if path, err := exec.LookPath(name); err == nil && path != "" {
				return path, nil
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}
		candidates := []string{}
		if appData := os.Getenv("APPDATA"); appData != "" {
			candidates = append(candidates,
				filepath.Join(appData, "npm", "kimchi.cmd"),
				filepath.Join(appData, "npm", "kimchi.exe"),
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
		return "", fmt.Errorf("kimchi: %w", ports.ErrAgentBinaryNotFound)
	}

	if path, err := exec.LookPath("kimchi"); err == nil && path != "" {
		return path, nil
	}

	candidates := []string{
		"/usr/local/bin/kimchi",
		"/opt/homebrew/bin/kimchi",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "kimchi"),
			filepath.Join(home, ".npm-global", "bin", "kimchi"),
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

	return "", fmt.Errorf("kimchi: %w", ports.ErrAgentBinaryNotFound)
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

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
