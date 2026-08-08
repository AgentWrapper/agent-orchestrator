package kimchi

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
	settingsDirName  = ".kimchi"
	settingsFileName = "hooks.local.json"

	hookCommandPrefix = "ao hooks kimchi "
	hookTimeout       = 30
)

type matcherGroup struct {
	Matcher *string     `json:"matcher,omitempty"`
	Hooks   []hookEntry `json:"hooks"`
}

type hookEntry struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
}

type hookSpec struct {
	Event   string
	Matcher *string
	Command string
}

var startupMatcher = "startup"

var managedHooks = []hookSpec{
	{Event: "SessionStart", Matcher: &startupMatcher, Command: hookCommandPrefix + "session-start"},
	{Event: "UserPromptSubmit", Command: hookCommandPrefix + "user-prompt-submit"},
	{Event: "Stop", Command: hookCommandPrefix + "stop"},
	{Event: "Notification", Command: hookCommandPrefix + "notification"},
	{Event: "SessionEnd", Command: hookCommandPrefix + "session-end"},
	{Event: "PreToolUse", Command: hookCommandPrefix + "pre-tool-use"},
	{Event: "PostToolUse", Command: hookCommandPrefix + "post-tool-use"},
	// PostToolUseFail is Kimchi's native event name, not Claude Code's
	// PostToolUseFailure — the wrong name silently fails to fire.
	{Event: "PostToolUseFail", Command: hookCommandPrefix + "post-tool-use-fail"},
}

// GetAgentHooks installs AO's hooks into the worktree-local
// .kimchi/hooks.local.json file. Kimchi reads this file via its always-on
// native hook adapter. Existing hooks and unrelated settings are preserved;
// duplicate AO commands are not appended. AO hooks previously installed in
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("kimchi.GetAgentHooks: WorkspacePath is required")
	}

	settingsPath := settingsPath(cfg.WorkspacePath)
	topLevel, rawHooks, err := readSettings(settingsPath)
	if err != nil {
		return fmt.Errorf("kimchi.GetAgentHooks: %w", err)
	}

	for event, specs := range groupHooksByEvent() {
		var existingGroups []matcherGroup
		if err := parseHookType(rawHooks, event, &existingGroups); err != nil {
			return fmt.Errorf("kimchi.GetAgentHooks: %w", err)
		}
		for _, spec := range specs {
			if !hookCommandExists(existingGroups, spec.Command) {
				entry := hookEntry{Type: "command", Command: spec.Command, Timeout: hookTimeout}
				existingGroups = addHook(existingGroups, entry, spec.Matcher)
			}
		}
		if err := marshalHookType(rawHooks, event, existingGroups); err != nil {
			return fmt.Errorf("kimchi.GetAgentHooks: %w", err)
		}
	}

	if err := writeSettings(settingsPath, topLevel, rawHooks); err != nil {
		return fmt.Errorf("kimchi.GetAgentHooks: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(settingsPath), settingsFileName); err != nil {
		return fmt.Errorf("kimchi.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

// UninstallHooks removes AO's hooks from the workspace-local
// .kimchi/hooks.local.json file, leaving user-defined hooks untouched.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("kimchi.UninstallHooks: workspacePath is required")
	}

	settingsPath := settingsPath(workspacePath)
	if _, err := os.Stat(settingsPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	topLevel, rawHooks, err := readSettings(settingsPath)
	if err != nil {
		return fmt.Errorf("kimchi.UninstallHooks: %w", err)
	}

	for _, event := range managedEvents() {
		var groups []matcherGroup
		if err := parseHookType(rawHooks, event, &groups); err != nil {
			return fmt.Errorf("kimchi.UninstallHooks: %w", err)
		}
		groups = removeManagedHooks(groups)
		if err := marshalHookType(rawHooks, event, groups); err != nil {
			return fmt.Errorf("kimchi.UninstallHooks: %w", err)
		}
	}

	if err := writeSettings(settingsPath, topLevel, rawHooks); err != nil {
		return fmt.Errorf("kimchi.UninstallHooks: %w", err)
	}
	return nil
}

// AreHooksInstalled reports whether any AO Kimchi hook is present in
// the workspace-local settings file.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("kimchi.AreHooksInstalled: workspacePath is required")
	}

	settingsPath := settingsPath(workspacePath)
	if _, err := os.Stat(settingsPath); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	_, rawHooks, err := readSettings(settingsPath)
	if err != nil {
		return false, fmt.Errorf("kimchi.AreHooksInstalled: %w", err)
	}

	for _, event := range managedEvents() {
		var groups []matcherGroup
		if err := parseHookType(rawHooks, event, &groups); err != nil {
			return false, fmt.Errorf("kimchi.AreHooksInstalled: %w", err)
		}
		for _, group := range groups {
			for _, hook := range group.Hooks {
				if isManagedHook(hook.Command) {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

func settingsPath(workspacePath string) string {
	return filepath.Join(workspacePath, settingsDirName, settingsFileName)
}

func readSettings(path string) (topLevel, rawHooks map[string]json.RawMessage, err error) {
	topLevel = map[string]json.RawMessage{}
	rawHooks = map[string]json.RawMessage{}

	data, err := os.ReadFile(path) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return topLevel, rawHooks, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", path, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return topLevel, rawHooks, nil
	}
	if err := json.Unmarshal(data, &topLevel); err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if hooksRaw, ok := topLevel["hooks"]; ok {
		if err := json.Unmarshal(hooksRaw, &rawHooks); err != nil {
			return nil, nil, fmt.Errorf("parse hooks in %s: %w", path, err)
		}
	}
	return topLevel, rawHooks, nil
}

func writeSettings(path string, topLevel, rawHooks map[string]json.RawMessage) error {
	if len(rawHooks) == 0 {
		delete(topLevel, "hooks")
	} else {
		hooksJSON, err := json.Marshal(rawHooks)
		if err != nil {
			return fmt.Errorf("encode hooks: %w", err)
		}
		topLevel["hooks"] = hooksJSON
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("create settings dir: %w", err)
	}
	data, err := json.MarshalIndent(topLevel, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	data = append(data, '\n')
	if err := hookutil.AtomicWriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func groupHooksByEvent() map[string][]hookSpec {
	byEvent := map[string][]hookSpec{}
	for _, spec := range managedHooks {
		byEvent[spec.Event] = append(byEvent[spec.Event], spec)
	}
	return byEvent
}

func managedEvents() []string {
	seen := map[string]bool{}
	events := make([]string, 0, len(managedHooks))
	for _, spec := range managedHooks {
		if !seen[spec.Event] {
			seen[spec.Event] = true
			events = append(events, spec.Event)
		}
	}
	return events
}

func isManagedHook(command string) bool {
	return strings.HasPrefix(command, hookCommandPrefix)
}

func removeManagedHooks(groups []matcherGroup) []matcherGroup {
	result := make([]matcherGroup, 0, len(groups))
	for _, group := range groups {
		kept := make([]hookEntry, 0, len(group.Hooks))
		for _, hook := range group.Hooks {
			if !isManagedHook(hook.Command) {
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

func parseHookType(rawHooks map[string]json.RawMessage, event string, target *[]matcherGroup) error {
	data, ok := rawHooks[event]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("parse %s hooks: %w", event, err)
	}
	return nil
}

func marshalHookType(rawHooks map[string]json.RawMessage, event string, groups []matcherGroup) error {
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

func hookCommandExists(groups []matcherGroup, command string) bool {
	for _, group := range groups {
		for _, hook := range group.Hooks {
			if hook.Command == command {
				return true
			}
		}
	}
	return false
}

func addHook(groups []matcherGroup, hook hookEntry, matcher *string) []matcherGroup {
	for i, group := range groups {
		if matchersEqual(group.Matcher, matcher) {
			groups[i].Hooks = append(groups[i].Hooks, hook)
			return groups
		}
	}
	return append(groups, matcherGroup{Matcher: matcher, Hooks: []hookEntry{hook}})
}

func matchersEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
