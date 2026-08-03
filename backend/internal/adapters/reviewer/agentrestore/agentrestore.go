// Package agentrestore contains shared restore plumbing for reviewer adapters
// that wrap an AO agent adapter.
package agentrestore

import (
	"context"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Options carries reviewer policy that must be reapplied when resuming a native
// agent conversation.
type Options struct {
	Permissions     ports.PermissionMode
	AllowedTools    []string
	DisallowedTools []string
}

// Command asks the wrapped agent adapter to resume the reviewer's native
// conversation. ok=false means no native id has been captured yet, so callers
// may fall back to a fresh idle launch for legacy review rows.
func Command(ctx context.Context, agent ports.Agent, inv ports.ReviewInvocation, opts Options) (ports.ReviewCommandSpec, bool, error) {
	agentSessionID := strings.TrimSpace(inv.AgentSessionID)
	if agentSessionID == "" {
		return ports.ReviewCommandSpec{}, false, nil
	}
	argv, ok, err := agent.GetRestoreCommand(ctx, ports.RestoreConfig{
		Session: ports.SessionRef{
			ID:            inv.ReviewerID,
			WorkspacePath: inv.WorkspacePath,
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: agentSessionID},
		},
		Kind:             domain.KindWorker,
		Permissions:      opts.Permissions,
		AllowedTools:     opts.AllowedTools,
		DisallowedTools:  opts.DisallowedTools,
		SystemPrompt:     inv.SystemPrompt,
		SystemPromptFile: inv.SystemPromptFile,
	})
	if err != nil || !ok {
		return ports.ReviewCommandSpec{}, ok, err
	}
	return ports.ReviewCommandSpec{Argv: argv}, true, nil
}
