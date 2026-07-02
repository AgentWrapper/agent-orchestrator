package claudecode

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
	claudeSettingsDirName  = ".claude"
	claudeSettingsFileName = "settings.local.json"

	// claudeHookCommandPrefix identifies the hook commands AO owns. Every
	// managed command starts with it, so install can skip duplicates and
	// uninstall can recognize AO entries by prefix without an embedded
	// template to diff against.
	claudeHookCommandPrefix = "ao hooks claude-code "
	claudeHookTimeout       = 30
)

type claudeMatcherGroup struct {
	// Matcher is a pointer so it round-trips exactly: SessionStart requires a
	// real matcher ("startup"); UserPromptSubmit/Stop omit it (Claude ignores
	// matcher for those events). omitempty drops a nil matcher on write.
	Matcher *string           `json:"matcher,omitempty"`
	Hooks   []claudeHookEntry `json:"hooks"`
}

type claudeHookEntry struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
}

// claudeHookSpec describes one hook AO installs, defined in code rather
// than read from an embedded settings file.
type claudeHookSpec struct {
	Event   string
	Matcher *string
	Command string
}

// claudeStartupMatcher is referenced by pointer so SessionStart serializes with
// its required "startup" matcher.
var claudeStartupMatcher = "startup"

// claudeManagedHooks is the source of truth for the hooks AO installs:
// SessionStart (under the "startup" matcher), UserPromptSubmit, the tool-use
// trio (PreToolUse, PostToolUse, PostToolUseFailure), PermissionRequest,
// Stop, Notification, and SessionEnd. They report normalized session metadata
// and activity-state signals back into AO's store (see DeriveActivityState).
// Notification and SessionEnd carry no matcher: each installs once and fires
// for every sub-type, and the handler filters on the payload's
// notification_type / reason field — installing one command under multiple
// matchers would trip the per-command dedup in claudeHookCommandExists. The
// tool-use hooks also carry no matcher (fire for every tool): their payloads
// carry tool_name/tool_use_id, which lifecycle uses to clear a stale sticky
// `blocked` only when the specific approved tool finishes — the daemon-side
// precedence rule is what makes these signals safe against parallel-subagent
// traffic (the naive mapping without it was reverted in PR #5's review).
// PermissionRequest fires when a permission dialog appears and carries the
// blocking tool_name; `ao hooks` writes nothing to stdout, so installing it
// never injects a permission decision.
var claudeManagedHooks = []claudeHookSpec{
	{Event: "SessionStart", Matcher: &claudeStartupMatcher, Command: claudeHookCommandPrefix + "session-start"},
	{Event: "UserPromptSubmit", Command: claudeHookCommandPrefix + "user-prompt-submit"},
	{Event: "PreToolUse", Command: claudeHookCommandPrefix + "pre-tool-use"},
	{Event: "PostToolUse", Command: claudeHookCommandPrefix + "post-tool-use"},
	{Event: "PostToolUseFailure", Command: claudeHookCommandPrefix + "post-tool-use-failure"},
	{Event: "PermissionRequest", Command: claudeHookCommandPrefix + "permission-request"},
	{Event: "Stop", Command: claudeHookCommandPrefix + "stop"},
	{Event: "Notification", Command: claudeHookCommandPrefix + "notification"},
	{Event: "SessionEnd", Command: claudeHookCommandPrefix + "session-end"},
}

// GetAgentHooks installs AO's Claude Code hooks into the worktree-local
// .claude/settings.local.json file (the per-session local settings, not the
// shared .claude/settings.json). The hooks (see claudeManagedHooks) report
// normalized session metadata and
// activity-state signals back into AO's store. Existing hooks and unrelated
// settings are preserved, and duplicate AO commands are not appended, so
// the install is idempotent.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("claude-code.GetAgentHooks: WorkspacePath is required")
	}

	settingsPath := claudeSettingsPath(cfg.WorkspacePath)
	topLevel, rawHooks, err := readClaudeSettings(settingsPath)
	if err != nil {
		return fmt.Errorf("claude-code.GetAgentHooks: %w", err)
	}

	for event, specs := range groupClaudeHooksByEvent() {
		var existingGroups []claudeMatcherGroup
		if err := parseClaudeHookType(rawHooks, event, &existingGroups); err != nil {
			return fmt.Errorf("claude-code.GetAgentHooks: %w", err)
		}
		for _, spec := range specs {
			if !claudeHookCommandExists(existingGroups, spec.Command) {
				entry := claudeHookEntry{Type: "command", Command: spec.Command, Timeout: claudeHookTimeout}
				existingGroups = addClaudeHook(existingGroups, entry, spec.Matcher)
			}
		}
		if err := marshalClaudeHookType(rawHooks, event, existingGroups); err != nil {
			return fmt.Errorf("claude-code.GetAgentHooks: %w", err)
		}
	}

	if err := writeClaudeSettings(settingsPath, topLevel, rawHooks); err != nil {
		return fmt.Errorf("claude-code.GetAgentHooks: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(settingsPath), claudeSettingsFileName); err != nil {
		return fmt.Errorf("claude-code.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

// UninstallHooks removes AO's Claude Code hooks from the workspace-local
// .claude/settings.local.json file, leaving user-defined hooks and unrelated
// settings untouched. A missing settings file is a no-op.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("claude-code.UninstallHooks: workspacePath is required")
	}

	settingsPath := claudeSettingsPath(workspacePath)
	if _, err := os.Stat(settingsPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	topLevel, rawHooks, err := readClaudeSettings(settingsPath)
	if err != nil {
		return fmt.Errorf("claude-code.UninstallHooks: %w", err)
	}

	for _, event := range claudeManagedEvents() {
		var groups []claudeMatcherGroup
		if err := parseClaudeHookType(rawHooks, event, &groups); err != nil {
			return fmt.Errorf("claude-code.UninstallHooks: %w", err)
		}
		groups = removeClaudeManagedHooks(groups)
		if err := marshalClaudeHookType(rawHooks, event, groups); err != nil {
			return fmt.Errorf("claude-code.UninstallHooks: %w", err)
		}
	}

	if err := writeClaudeSettings(settingsPath, topLevel, rawHooks); err != nil {
		return fmt.Errorf("claude-code.UninstallHooks: %w", err)
	}
	return nil
}

// AreHooksInstalled reports whether any AO Claude Code hook is present in
// the workspace-local settings file. A missing file means none are installed.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("claude-code.AreHooksInstalled: workspacePath is required")
	}

	settingsPath := claudeSettingsPath(workspacePath)
	if _, err := os.Stat(settingsPath); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	_, rawHooks, err := readClaudeSettings(settingsPath)
	if err != nil {
		return false, fmt.Errorf("claude-code.AreHooksInstalled: %w", err)
	}

	for _, event := range claudeManagedEvents() {
		var groups []claudeMatcherGroup
		if err := parseClaudeHookType(rawHooks, event, &groups); err != nil {
			return false, fmt.Errorf("claude-code.AreHooksInstalled: %w", err)
		}
		for _, group := range groups {
			for _, hook := range group.Hooks {
				if isClaudeManagedHook(hook.Command) {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

func claudeSettingsPath(workspacePath string) string {
	return filepath.Join(workspacePath, claudeSettingsDirName, claudeSettingsFileName)
}

// readClaudeSettings loads the settings file into a top-level raw map plus the
// decoded "hooks" sub-map, preserving every key AO doesn't manage. A
// missing or empty file yields empty maps.
func readClaudeSettings(settingsPath string) (topLevel, rawHooks map[string]json.RawMessage, err error) {
	topLevel = map[string]json.RawMessage{}
	rawHooks = map[string]json.RawMessage{}

	data, err := os.ReadFile(settingsPath) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return topLevel, rawHooks, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", settingsPath, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return topLevel, rawHooks, nil
	}
	if err := json.Unmarshal(data, &topLevel); err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", settingsPath, err)
	}
	if hooksRaw, ok := topLevel["hooks"]; ok {
		if err := json.Unmarshal(hooksRaw, &rawHooks); err != nil {
			return nil, nil, fmt.Errorf("parse hooks in %s: %w", settingsPath, err)
		}
	}
	return topLevel, rawHooks, nil
}

// writeClaudeSettings folds rawHooks back into topLevel and writes the file. An
// empty hooks map drops the "hooks" key entirely.
func writeClaudeSettings(settingsPath string, topLevel, rawHooks map[string]json.RawMessage) error {
	if len(rawHooks) == 0 {
		delete(topLevel, "hooks")
	} else {
		hooksJSON, err := json.Marshal(rawHooks)
		if err != nil {
			return fmt.Errorf("encode hooks: %w", err)
		}
		topLevel["hooks"] = hooksJSON
	}

	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o750); err != nil {
		return fmt.Errorf("create settings dir: %w", err)
	}
	data, err := json.MarshalIndent(topLevel, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", settingsPath, err)
	}
	data = append(data, '\n')
	if err := hookutil.AtomicWriteFile(settingsPath, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", settingsPath, err)
	}
	return nil
}

// groupClaudeHooksByEvent groups the managed hook specs by their Claude event so
// each event's settings array is rewritten once.
func groupClaudeHooksByEvent() map[string][]claudeHookSpec {
	byEvent := map[string][]claudeHookSpec{}
	for _, spec := range claudeManagedHooks {
		byEvent[spec.Event] = append(byEvent[spec.Event], spec)
	}
	return byEvent
}

// claudeManagedEvents returns the distinct Claude events AO manages, in
// the order they first appear in claudeManagedHooks.
func claudeManagedEvents() []string {
	seen := map[string]bool{}
	events := make([]string, 0, len(claudeManagedHooks))
	for _, spec := range claudeManagedHooks {
		if !seen[spec.Event] {
			seen[spec.Event] = true
			events = append(events, spec.Event)
		}
	}
	return events
}

func isClaudeManagedHook(command string) bool {
	return strings.HasPrefix(command, claudeHookCommandPrefix)
}

// removeClaudeManagedHooks strips AO hook entries from every group,
// dropping any group left without hooks so the event array doesn't accumulate
// empty matcher objects.
func removeClaudeManagedHooks(groups []claudeMatcherGroup) []claudeMatcherGroup {
	result := make([]claudeMatcherGroup, 0, len(groups))
	for _, group := range groups {
		kept := make([]claudeHookEntry, 0, len(group.Hooks))
		for _, hook := range group.Hooks {
			if !isClaudeManagedHook(hook.Command) {
				kept = append(kept, hook)
			}
		}
		if len(kept) > 0 {
			group.Hooks = kept
			result = append(result, group)
		}
	}
	return result
}

func parseClaudeHookType(rawHooks map[string]json.RawMessage, event string, target *[]claudeMatcherGroup) error {
	data, ok := rawHooks[event]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("parse %s hooks: %w", event, err)
	}
	return nil
}

func marshalClaudeHookType(rawHooks map[string]json.RawMessage, event string, groups []claudeMatcherGroup) error {
	if len(groups) == 0 {
		delete(rawHooks, event)
		return nil
	}
	data, err := json.Marshal(groups)
	if err != nil {
		return fmt.Errorf("encode %s hooks: %w", event, err)
	}
	rawHooks[event] = data
	return nil
}

func claudeHookCommandExists(groups []claudeMatcherGroup, command string) bool {
	for _, group := range groups {
		for _, hook := range group.Hooks {
			if hook.Command == command {
				return true
			}
		}
	}
	return false
}

// addClaudeHook appends hook to an existing group with the same matcher (so a
// SessionStart hook lands under its "startup" matcher), creating that group if
// none matches.
func addClaudeHook(groups []claudeMatcherGroup, hook claudeHookEntry, matcher *string) []claudeMatcherGroup {
	for i, group := range groups {
		if matchersEqual(group.Matcher, matcher) {
			groups[i].Hooks = append(groups[i].Hooks, hook)
			return groups
		}
	}
	return append(groups, claudeMatcherGroup{Matcher: matcher, Hooks: []claudeHookEntry{hook}})
}

func matchersEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
