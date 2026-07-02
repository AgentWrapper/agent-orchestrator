package copilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// copilotHooksDir is the repository-scope hooks directory Copilot CLI reads
	// (.github/hooks/*.json). AO writes a single dedicated file there so it never
	// disturbs other hook files the user or repo may ship.
	copilotHooksDir      = ".github/hooks"
	copilotHooksFileName = "ao.json"

	// copilotHooksVersion is the schema version of the hooks file (Copilot uses 1).
	copilotHooksVersion = 1

	// copilotHookCommandPrefix identifies the hook commands AO owns, so install
	// skips duplicates and uninstall recognizes AO entries by prefix without an
	// embedded template to diff against. The CLI dispatcher routes
	// `ao hooks copilot <event>` to DeriveActivityState.
	copilotHookCommandPrefix = "ao hooks copilot "
	copilotHookTimeoutSec    = 30
)

// copilotHookFile is the on-disk shape of .github/hooks/ao.json. AO owns this
// dedicated file outright, so it only models the keys it manages (version,
// disableAllHooks, hooks); user-defined hooks live in their own .github/hooks/*
// files and are never touched.
type copilotHookFile struct {
	Version         int                           `json:"version"`
	DisableAllHooks *bool                         `json:"disableAllHooks,omitempty"`
	Hooks           map[string][]copilotHookEntry `json:"hooks"`
}

// copilotHookEntry is one hook command. Copilot entries carry separate bash and
// powershell command strings (both required for cross-platform), a type, an
// optional working dir, and a timeout in seconds.
type copilotHookEntry struct {
	Type       string `json:"type"`
	Bash       string `json:"bash,omitempty"`
	Powershell string `json:"powershell,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	TimeoutSec int    `json:"timeoutSec,omitempty"`
}

// copilotHookSpec describes one hook AO installs, defined in code rather than
// read from an embedded settings file.
type copilotHookSpec struct {
	// Event is the native Copilot camelCase event name (sessionStart, ...).
	Event string
	// Command is the AO sub-command suffix (session-start, ...). It is appended
	// to copilotHookCommandPrefix to form both the bash and powershell command,
	// and is the value DeriveActivityState switches on.
	Command string
}

// copilotManagedHooks is the source of truth for the hooks AO installs. The AO
// sub-command names (session-start, user-prompt-submit, permission-request,
// stop) are exactly what DeriveActivityState in activity.go switches on.
//
// Native event names use Copilot's camelCase form, taken verbatim from
// https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
// (sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse,
// errorOccurred, agentStop). Copilot does not document a "permissionRequest"
// event — the closest signal that AO's permission-request sub-command can
// piggyback on is preToolUse, which fires before any tool invocation, including
// the ones that would otherwise prompt the user for approval. This is a
// many-to-one collapse: every preToolUse currently produces ActivityBlocked
// via the permission-request sub-command. agentStop is the per-turn completion
// signal and maps to the "stop" sub-command (turn end → idle).
var copilotManagedHooks = []copilotHookSpec{
	{Event: "sessionStart", Command: "session-start"},
	{Event: "userPromptSubmitted", Command: "user-prompt-submit"},
	{Event: "preToolUse", Command: "permission-request"},
	{Event: "agentStop", Command: "stop"},
}

// GetAgentHooks installs AO's Copilot hooks into the worktree-local
// .github/hooks/ao.json file (the repository-scope hooks config Copilot CLI
// reads). The hooks report normalized activity-state signals back into AO's
// store. Existing AO entries are not duplicated and any unrelated keys are
// preserved, so the install is idempotent.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("copilot.GetAgentHooks: WorkspacePath is required")
	}

	hooksPath := copilotHooksPath(cfg.WorkspacePath)
	file, err := readCopilotHooks(hooksPath)
	if err != nil {
		return fmt.Errorf("copilot.GetAgentHooks: %w", err)
	}

	if file.Hooks == nil {
		file.Hooks = map[string][]copilotHookEntry{}
	}
	for _, spec := range copilotManagedHooks {
		command := copilotHookCommandPrefix + spec.Command
		if copilotHookCommandExists(file.Hooks[spec.Event], command) {
			continue
		}
		file.Hooks[spec.Event] = append(file.Hooks[spec.Event], copilotHookEntry{
			Type:       "command",
			Bash:       command,
			Powershell: command,
			TimeoutSec: copilotHookTimeoutSec,
		})
	}

	if err := writeCopilotHooks(hooksPath, file); err != nil {
		return fmt.Errorf("copilot.GetAgentHooks: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(hooksPath), copilotHooksFileName); err != nil {
		return fmt.Errorf("copilot.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

// UninstallHooks removes AO's Copilot hooks from the workspace-local
// .github/hooks/ao.json file, leaving user-defined hooks and unrelated keys
// untouched. A missing file is a no-op.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("copilot.UninstallHooks: workspacePath is required")
	}

	hooksPath := copilotHooksPath(workspacePath)
	if _, err := os.Stat(hooksPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	file, err := readCopilotHooks(hooksPath)
	if err != nil {
		return fmt.Errorf("copilot.UninstallHooks: %w", err)
	}

	for event, entries := range file.Hooks {
		kept := removeCopilotManagedHooks(entries)
		if len(kept) == 0 {
			delete(file.Hooks, event)
			continue
		}
		file.Hooks[event] = kept
	}

	if err := writeCopilotHooks(hooksPath, file); err != nil {
		return fmt.Errorf("copilot.UninstallHooks: %w", err)
	}
	return nil
}

// AreHooksInstalled reports whether any AO Copilot hook is present in the
// workspace-local hooks file. A missing file means none are installed.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("copilot.AreHooksInstalled: workspacePath is required")
	}

	hooksPath := copilotHooksPath(workspacePath)
	if _, err := os.Stat(hooksPath); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	file, err := readCopilotHooks(hooksPath)
	if err != nil {
		return false, fmt.Errorf("copilot.AreHooksInstalled: %w", err)
	}

	for _, entries := range file.Hooks {
		for _, entry := range entries {
			if isCopilotManagedHook(entry) {
				return true, nil
			}
		}
	}
	return false, nil
}

func copilotHooksPath(workspacePath string) string {
	return filepath.Join(workspacePath, filepath.FromSlash(copilotHooksDir), copilotHooksFileName)
}

// readCopilotHooks loads the hooks file. A missing or empty file yields an empty
// file struct with a nil hooks map (and the AO schema version, used on write).
func readCopilotHooks(hooksPath string) (copilotHookFile, error) {
	file := copilotHookFile{Version: copilotHooksVersion}

	data, err := os.ReadFile(hooksPath) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return copilotHookFile{}, fmt.Errorf("read %s: %w", hooksPath, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return file, nil
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return copilotHookFile{}, fmt.Errorf("parse %s: %w", hooksPath, err)
	}
	if file.Version == 0 {
		file.Version = copilotHooksVersion
	}
	return file, nil
}

// writeCopilotHooks writes the file. An empty hooks map still writes a valid
// (versioned) file so AreHooksInstalled and re-install see a consistent shape.
func writeCopilotHooks(hooksPath string, file copilotHookFile) error {
	if file.Version == 0 {
		file.Version = copilotHooksVersion
	}
	if file.Hooks == nil {
		file.Hooks = map[string][]copilotHookEntry{}
	}

	if err := os.MkdirAll(filepath.Dir(hooksPath), 0o750); err != nil {
		return fmt.Errorf("create hooks dir: %w", err)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", hooksPath, err)
	}
	data = append(data, '\n')
	if err := atomicWriteFile(hooksPath, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", hooksPath, err)
	}
	return nil
}

// atomicWriteFile writes data to path via a temp file in the same directory
// followed by a rename, so a crash or signal mid-write can't leave a truncated
// or empty file that Copilot then fails to parse (silently disabling hooks).
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".ao-tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once renamed
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// isCopilotManagedHook reports whether an entry is one AO owns, recognized by the
// command prefix on either the bash or powershell command.
func isCopilotManagedHook(entry copilotHookEntry) bool {
	return strings.HasPrefix(entry.Bash, copilotHookCommandPrefix) ||
		strings.HasPrefix(entry.Powershell, copilotHookCommandPrefix)
}

func copilotHookCommandExists(entries []copilotHookEntry, command string) bool {
	for _, entry := range entries {
		if entry.Bash == command || entry.Powershell == command {
			return true
		}
	}
	return false
}

// removeCopilotManagedHooks strips AO hook entries from a slice, preserving
// user-defined entries in order.
func removeCopilotManagedHooks(entries []copilotHookEntry) []copilotHookEntry {
	kept := make([]copilotHookEntry, 0, len(entries))
	for _, entry := range entries {
		if !isCopilotManagedHook(entry) {
			kept = append(kept, entry)
		}
	}
	return kept
}
