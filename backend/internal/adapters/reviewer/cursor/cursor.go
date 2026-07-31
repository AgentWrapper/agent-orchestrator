// Package cursor adapts the Cursor CLI worker agent for code-review sessions.
package cursor

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	workeragent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/cursor"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Reviewer is the Cursor code-review adapter.
type Reviewer struct {
	agent ports.Agent
}

// New builds the Cursor reviewer adapter.
func New() *Reviewer {
	return &Reviewer{agent: workeragent.New()}
}

// Harness identifies this reviewer in the reviewer registry.
func (r *Reviewer) Harness() domain.ReviewerHarness {
	return domain.ReviewerCursor
}

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// PreLaunch installs the reviewer-only Cursor permissions into an AO-owned
// profile. The user's Cursor configuration is used only as a seed and is never
// modified.
func (r *Reviewer) PreLaunch(ctx context.Context, inv ports.ReviewInvocation) error {
	return installReviewerConfig(ctx, inv)
}

// ReviewCommand launches Cursor's persistent interactive TUI in Ask mode.
// PermissionModeAuto retains --force so explicitly allowed inspection and
// reporting commands do not wait for approval. Ask mode plus the enabled
// sandbox is the write boundary: Cursor permissions match only the first shell
// token, so Shell(git) cannot safely express a read-only subcommand policy.
// Cursor has no system-prompt flag, so the short initial prompt points it at
// both AO-owned prompt files without exposing their contents in argv.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	prompt := cursorPrompt(inv)
	argv, err := r.agent.GetLaunchCommand(ctx, ports.LaunchConfig{
		SessionID:     inv.ReviewerID,
		WorkspacePath: inv.WorkspacePath,
		Prompt:        prompt,
		Permissions:   ports.PermissionModeAuto,
	})
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	flags := []string{"--mode", "ask", "--sandbox", "enabled", "--trust"}
	if strings.TrimSpace(inv.TaskPromptRoot) != "" {
		flags = append(flags, "--add-dir", inv.TaskPromptRoot)
	}
	return ports.ReviewCommandSpec{
		Argv: insertBeforePrompt(argv, flags...),
		Env:  reviewerEnv(inv),
	}, nil
}

func cursorPrompt(inv ports.ReviewInvocation) string {
	if inv.SystemPromptFile != "" && inv.TaskPromptFile != "" {
		return fmt.Sprintf(
			"Read and follow the AO reviewer role in `%s`, then complete the AO review task in `%s`.",
			filepath.ToSlash(inv.SystemPromptFile),
			filepath.ToSlash(inv.TaskPromptFile),
		)
	}
	return strings.TrimSpace(inv.Prompt)
}

// ReviewMessage returns the centrally-authored task for the persistent pane.
func (r *Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewCancel stops the active Cursor reviewer turn while preserving the
// terminal pane for inspection.
func (r *Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 2}, nil
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
