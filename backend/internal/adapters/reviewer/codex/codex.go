// Package codex adapts the codex worker agent for code-review sessions.
package codex

import (
	"context"

	workeragent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/codex"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Reviewer is the codex code-review adapter.
type Reviewer struct {
	agent ports.Agent
}

// New builds the codex reviewer adapter.
func New() *Reviewer {
	return &Reviewer{agent: workeragent.New()}
}

// Harness identifies this reviewer in the reviewer registry.
func (r *Reviewer) Harness() domain.ReviewerHarness {
	return domain.ReviewerCodex
}

var _ ports.Reviewer = (*Reviewer)(nil)

// ReviewCommand launches the reviewer with an enforced read-only filesystem
// sandbox. Auto approval lets the headless session request the narrowly needed
// network access for posting the review and reporting its result.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	argv, err := r.agent.GetLaunchCommand(ctx, ports.LaunchConfig{
		SessionID:     inv.ReviewerID,
		WorkspacePath: inv.WorkspacePath,
		Prompt:        inv.Prompt,
		SystemPrompt:  inv.SystemPrompt,
		Permissions:   ports.PermissionModeAuto,
	})
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{Argv: insertBeforePrompt(argv, "--sandbox", "read-only")}, nil
}

// ReviewMessage returns the centrally-authored task for an existing pane.
func (r *Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

func insertBeforePrompt(argv []string, extra ...string) []string {
	for i, arg := range argv {
		if arg == "--" {
			out := make([]string, 0, len(argv)+len(extra))
			out = append(out, argv[:i]...)
			out = append(out, extra...)
			return append(out, argv[i:]...)
		}
	}
	return append(argv, extra...)
}
