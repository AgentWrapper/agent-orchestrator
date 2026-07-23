// Package kimchi adapts the Kimchi worker agent for code-review sessions.
package kimchi

import (
	"context"

	workeragent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/kimchi"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// reviewerAllowedTools is the read-only tool allowlist the reviewer launches
// with. The reviewer runs headless (no human to approve prompts) but must stay
// read-only, so instead of bypassPermissions — which skips the permission
// system entirely and ignores allow/deny rules — it launches in --auto mode
// where these rules are honored: allow rules auto-approve without prompting,
// so the reviewer can read the checkout and run the few commands it needs (git
// diff/log/status to inspect the PR and `ao review submit` to record the
// verdict) without stalling. printf, gh, and git show are intentionally
// excluded — printf is a write primitive (printf 'x' > file), gh exposes the
// full mutation surface (self-merge, gh api --method DELETE/PUT), and git
// show can read arbitrary tracked content like .env.production. Kimchi's
// rule parser is case-insensitive on tool names, so lowercase tool names are
// used to match Kimchi's internal names.
var reviewerAllowedTools = []string{
	"read",
	"grep",
	"glob",
	"bash(git diff:*)",
	"bash(git log:*)",
	"bash(git status:*)",
	"bash(ao review submit:*)",
}

// reviewerDisallowedTools hard-denies the write and exfiltration paths as
// defense in depth, so a misbehaving model cannot edit files, move the branch,
// read arbitrary tracked content, or post mutations via gh even if a future
// allowlist entry would otherwise admit it. Kimchi has no NotebookEdit tool, so
// it is omitted from the deny list.
var reviewerDisallowedTools = []string{
	"edit",
	"write",
	"bash(git push:*)",
	"bash(git commit:*)",
	"bash(git show:*)",
	"bash(gh:*)",
}

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
// worker's checkout. --auto lets the headless session run without prompting
// while still honoring the allow/deny tool lists, which enforce read-only
// operation: allow rules auto-approve the read-only review tools (git
// diff/log/status to inspect the PR, `ao review submit` to record the verdict)
// without stalling, and the deny list hard-blocks the write and exfiltration
// paths (including gh and git show) as defense in depth.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	argv, err := r.agent.GetLaunchCommand(ctx, ports.LaunchConfig{
		SessionID:       inv.ReviewerID,
		WorkspacePath:   inv.WorkspacePath,
		Prompt:          inv.Prompt,
		SystemPrompt:    inv.SystemPrompt,
		Permissions:     ports.PermissionModeAuto,
		AllowedTools:    reviewerAllowedTools,
		DisallowedTools: reviewerDisallowedTools,
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
