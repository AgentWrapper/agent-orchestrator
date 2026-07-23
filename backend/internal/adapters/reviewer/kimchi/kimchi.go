// Package kimchi adapts the Kimchi worker agent for code-review sessions.
package kimchi

import (
	"context"

	workeragent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/kimchi"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Reviewer is the Kimchi code-review adapter.
type Reviewer struct {
	agent ports.Agent
}

// New builds the Kimchi reviewer adapter.
func New() *Reviewer {
	return &Reviewer{agent: workeragent.New()}
}

// Harness identifies this reviewer in the reviewer registry.
func (r *Reviewer) Harness() domain.ReviewerHarness {
	return domain.ReviewerKimchi
}

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand builds the argv to launch a fresh Kimchi reviewer over the
// worker's checkout. Auto approval lets the headless session run without
// prompting; the reviewer prompt enforces read-only operation by instruction.
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
	return ports.ReviewCommandSpec{Argv: argv}, nil
}

// ReviewMessage returns the centrally-authored task for an existing pane.
func (r *Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel stops the active Kimchi reviewer turn while preserving the
// terminal pane for inspection.
func (r *Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 2}, nil
}
