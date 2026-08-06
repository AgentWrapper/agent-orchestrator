package muse

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// GetAgentHooks deliberately does not install workspace files. Muse receives
// AO's standing prompt from the process-local environment assembled by
// GetLaunchCommand, leaving tracked and untracked project state untouched.
func (p *Plugin) GetAgentHooks(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	return ctx.Err()
}

// CleanupWorkspace is intentionally a no-op because prompt injection is
// process-local. Keeping the lifecycle hook explicit makes launch rollback and
// teardown safe even when the workspace has an existing AGENTS.md.
func (p *Plugin) CleanupWorkspace(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	return ctx.Err()
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
