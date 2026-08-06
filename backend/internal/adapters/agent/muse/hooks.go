package muse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hooksjson"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	museManagedHooksEnvVar = "TBH_MANAGED_HOOKS_PATH"
	museHookCommandPrefix  = "ao hooks muse "
)

var museManagedHooks = map[string][]hooksjson.MatcherGroup{
	"SessionStart":      {museHookGroup("session-start")},
	"UserPromptSubmit":  {museHookGroup("user-prompt-submit")},
	"PreToolUse":        {museHookGroup("pre-tool-use")},
	"PermissionRequest": {museHookGroup("permission-request")},
	"PostToolUse":       {museHookGroup("post-tool-use")},
	"Stop":              {museHookGroup("stop")},
}

type museHooksFile struct {
	Hooks map[string][]hooksjson.MatcherGroup `json:"hooks"`
}

func museHookGroup(event string) hooksjson.MatcherGroup {
	return hooksjson.MatcherGroup{Hooks: []hooksjson.HookEntry{{
		Type:    "command",
		Command: museHookCommandPrefix + event,
		Timeout: 5,
	}}}
}

// GetAgentHooks writes Muse's managed-hook configuration under AO's data
// directory. Muse receives its path through a process-local environment
// variable, so this does not create or modify any file in the project.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := museManagedHooksPath(cfg.DataDir, cfg.SessionID)
	if err != nil {
		return fmt.Errorf("muse.GetAgentHooks: %w", err)
	}
	data, err := json.MarshalIndent(museHooksFile{Hooks: museManagedHooks}, "", "  ")
	if err != nil {
		return fmt.Errorf("muse.GetAgentHooks: marshal hooks: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("muse.GetAgentHooks: create hooks directory: %w", err)
	}
	if err := hookutil.AtomicWriteFile(path, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("muse.GetAgentHooks: write hooks: %w", err)
	}
	return nil
}

// CleanupWorkspace removes the AO-owned managed-hook file. The method name is
// part of the shared agent lifecycle; Muse's project workspace stays untouched.
func (p *Plugin) CleanupWorkspace(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := museManagedHooksPath(cfg.DataDir, cfg.SessionID)
	if err != nil {
		return fmt.Errorf("muse.CleanupWorkspace: %w", err)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("muse.CleanupWorkspace: remove hooks: %w", err)
	}
	return nil
}

func museManagedHooksPath(dataDir, sessionID string) (string, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return "", errors.New("DataDir is required")
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", errors.New("SessionID is required")
	}
	if sessionID == "." || filepath.Base(sessionID) != sessionID {
		return "", errors.New("SessionID must be a single path component")
	}
	return filepath.Join(dataDir, "agent-hooks", adapterID, sessionID+".json"), nil
}

func museSystemPromptText(inline, file string) (string, error) {
	if strings.TrimSpace(inline) != "" {
		return strings.TrimRight(inline, "\n"), nil
	}
	if strings.TrimSpace(file) == "" {
		return "", nil
	}
	data, err := os.ReadFile(file) //nolint:gosec // path is AO-owned launch config
	if err != nil {
		return "", fmt.Errorf("read system prompt file: %w", err)
	}
	return strings.TrimRight(string(data), "\n"), nil
}
