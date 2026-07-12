// Package opencode adapts the opencode worker agent for code-review sessions.
package opencode

import (
	"context"
	"strings"

	workeragent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/opencode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const reviewerConfig = `{"permission":{"*":"deny","read":"allow","glob":"allow","grep":"allow","bash":{"*":"deny","gh api *":"allow","git diff*":"allow","git log*":"allow","git show*":"allow","git status*":"allow","ao review submit *":"allow","printf * | gh api *":"allow","printf * | ao review submit *":"allow"}}}`

// Reviewer is the opencode code-review adapter.
type Reviewer struct {
	agent ports.Agent
}

// New builds the opencode reviewer adapter.
func New() *Reviewer {
	return &Reviewer{agent: workeragent.New()}
}

// Harness identifies this reviewer in the reviewer registry.
func (r *Reviewer) Harness() domain.ReviewerHarness {
	return domain.ReviewerOpenCode
}

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand launches the reviewer with an inline permission policy that
// permits inspection and the two reporting commands while denying edits and
// every other tool. The system role is folded into the initial prompt because
// the worker CLI has no separate system-prompt flag.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	prompt := strings.TrimSpace(inv.SystemPrompt + "\n\n" + inv.Prompt)
	argv, err := r.agent.GetLaunchCommand(ctx, ports.LaunchConfig{
		SessionID:     inv.ReviewerID,
		WorkspacePath: inv.WorkspacePath,
		Prompt:        prompt,
		Permissions:   ports.PermissionModeAuto,
	})
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	return ports.ReviewCommandSpec{
		Argv: argv,
		Env:  map[string]string{"OPENCODE_CONFIG_CONTENT": reviewerConfig},
	}, nil
}

// ReviewMessage returns the centrally-authored task for an existing pane.
func (r *Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel stops the active OpenCode reviewer turn while preserving the
// terminal pane for inspection.
func (r *Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 2}, nil
}
