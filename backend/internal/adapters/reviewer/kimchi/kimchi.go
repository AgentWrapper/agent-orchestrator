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
// diff/log/status to inspect the PR, gh api to post the review, printf to pipe
// JSON, and `ao review submit` to record the verdict) without stalling.
//
// The review protocol (review/prompt.go step 1) requires the piped command:
//
//	printf '%s' '{...}' | gh api --method POST .../reviews --input -
//
// Kimchi's allow matcher is single-segment only, so piped commands can't be
// auto-approved by an allow rule — they fall to the classifier under --auto.
// Including both bash(printf:*) and bash(gh:*) ensures the classifier
// recognizes each segment. Dangerous gh verbs (merge, DELETE/PUT/PATCH, gist)
// are denied in reviewerDisallowedTools; git show is denied there too.
// Kimchi's rule parser is case-insensitive on tool names, so lowercase tool
// names are used to match Kimchi's internal names.
var reviewerAllowedTools = []string{
	"read",
	"grep",
	"glob",
	"bash(printf:*)",
	"bash(git diff:*)",
	"bash(git log:*)",
	"bash(git status:*)",
	"bash(gh:*)",
	"bash(ao review submit:*)",
}

// reviewerDisallowedTools hard-denies the write and exfiltration paths as
// defense in depth, so a misbehaving model cannot edit files, move the branch,
// read arbitrary tracked content, or post dangerous gh mutations even if a
// future allowlist entry would otherwise admit it. Kimchi's deny matcher
// checks all pipeline segments, so a denied program behind a pipe still blocks.
// Kimchi has no NotebookEdit tool, so it is omitted from the deny list.
//
// Deny-before-allow ordering: Kimchi's evaluateRules (in
// src/extensions/permissions/rules.ts) checks deny rules before allow rules
// within each source level (session > cli > local > project > user > builtin),
// so the deny list below IS effective despite the allow list above — a denied
// tool is always blocked regardless of allow rules. This ordering was verified
// directly from Kimchi source.
//
// The blanket bash(gh:*) deny was removed because the review protocol requires
// gh api --method POST to post reviews. Instead, specific dangerous gh verbs
// are denied: pr merge (self-merge), api --method DELETE/PUT/PATCH (mutate
// repo state), and gist (exfiltration). This is strictly safer than the
// claudecode reviewer, which allows all of gh:* and denies nothing in gh.
var reviewerDisallowedTools = []string{
	"edit",
	"write",
	"bash(git push:*)",
	"bash(git commit:*)",
	"bash(git show:*)",
	"bash(gh pr merge:*)",
	"bash(gh api --method DELETE:*)",
	"bash(gh api --method PUT:*)",
	"bash(gh api --method PATCH:*)",
	"bash(gh gist:*)",
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
var _ ports.ReviewerRestorer = (*Reviewer)(nil)

// ReviewCommand builds the argv to launch a fresh Kimchi reviewer over the
// worker's checkout. --auto lets the headless session run without prompting
// while still honoring the allow/deny tool lists, which enforce read-only
// operation: allow rules auto-approve the read-only review tools (git
// diff/log/status to inspect the PR, gh api to post the review, printf to pipe
// JSON, and `ao review submit` to record the verdict) without stalling, and
// the deny list hard-blocks the write, exfiltration, and dangerous gh
// mutation paths (git show, gh pr merge, gh api --method DELETE/PUT/PATCH,
// gh gist) as defense in depth.
//
// Note: bash(git diff:*) uses prefix matching, which admits --output=/tmp/file
// — a write bypass via Bash that the edit/write deny rules don't cover. This
// exposure is identical to the claudecode reviewer (already shipped), which
// allows Bash(git diff:*) with no OS sandbox. An OS-level read-only sandbox
// (like Codex's --sandbox read-only) is a cross-adapter concern tracked by
// ADR 0002 (docs/adr/0002-secure-interactive-reviewer-gateway.md), not a
// Kimchi-specific blocker.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	argv, err := r.agent.GetLaunchCommand(ctx, ports.LaunchConfig{
		SessionID:        inv.ReviewerID,
		WorkspacePath:    inv.WorkspacePath,
		Prompt:           inv.Prompt,
		SystemPrompt:     inv.SystemPrompt,
		SystemPromptFile: inv.SystemPromptFile,
		Permissions:      ports.PermissionModeAuto,
		AllowedTools:     reviewerAllowedTools,
		DisallowedTools:  reviewerDisallowedTools,
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

// ReviewRestoreCommand restores a recorded Kimchi reviewer pane by relaunching
// the request-scoped reviewer command with the current task context.
func (r *Reviewer) ReviewRestoreCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, bool, error) {
	cmd, err := r.ReviewCommand(ctx, inv)
	return cmd, true, err
}

// ReviewCancel stops the active Kimchi reviewer turn while preserving the
// terminal pane for inspection.
func (r *Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 2}, nil
}
