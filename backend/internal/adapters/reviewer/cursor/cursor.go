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
var _ ports.ReviewerPaneReusePolicy = (*Reviewer)(nil)

// ReviewCommand launches Cursor in headless Ask mode. Ask mode prevents code
// changes, while --force (selected by PermissionModeAuto) lets the reviewer run
// the git inspection and gh/ao reporting commands without waiting for a human
// approval prompt. Cursor has no system-prompt flag, so production invocations
// point it at both AO-owned prompt files.
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
	flags := []string{"--print", "--output-format", "text", "--mode=ask"}
	if strings.TrimSpace(inv.TaskPromptRoot) != "" {
		flags = append(flags, "--add-dir", inv.TaskPromptRoot)
	}
	return ports.ReviewCommandSpec{
		Argv: insertBeforePrompt(argv, flags...),
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
	return strings.TrimSpace(inv.SystemPrompt + "\n\n" + inv.Prompt)
}

// ReuseReviewerPane reports that headless Cursor exits after one pass. The
// launcher replaces its stable pane instead of sending a later task to the
// interactive shell that the runtime leaves behind.
func (r *Reviewer) ReuseReviewerPane() bool {
	return false
}

// ReviewMessage satisfies the reviewer contract. The launcher does not call it
// because ReuseReviewerPane returns false.
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
