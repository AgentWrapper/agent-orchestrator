// Package qwen contains AO's experimental host-trusted Qwen Code reviewer.
// Qwen runs as a visible, long-lived TUI in an AO-owned neutral directory.
package qwen

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	workerqwen "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/qwen"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/reviewgateway"
)

// HostTrustWarning describes the security boundary operators accept by using
// this experimental reviewer. Plan mode constrains model tool calls, but is not
// OS isolation: a terminal user can still invoke Qwen's ! shell or change mode.
const HostTrustWarning = "experimental host-trusted reviewer: Qwen has no OS isolation; terminal users can invoke the ! shell or change approval mode"

type binaryResolver func(context.Context) (string, error)

// Reviewer builds only Qwen's visible, long-lived interactive TUI command.
type Reviewer struct {
	resolveBinary binaryResolver
}

// New creates the Qwen reviewer. Production launch invocations supply the
// AO-owned data directory used for its neutral working and configuration roots.
func New() *Reviewer {
	return &Reviewer{resolveBinary: workerqwen.ResolveQwenBinary}
}

// Harness returns Qwen's reviewer identity.
func (r *Reviewer) Harness() domain.ReviewerHarness { return domain.ReviewerQwen }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)
var _ ports.ReviewerReusePolicy = (*Reviewer)(nil)

// ReviewCommand launches only Qwen's permanent interactive TUI. The task
// reference is injected after runtime creation so neither prompts nor prompt
// paths appear in process argv.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if !filepath.IsAbs(binary) {
		return ports.ReviewCommandSpec{}, errors.New("qwen reviewer: resolved binary must be absolute")
	}
	// Launcher preflight runs before request-scoped prompt and gateway state
	// exists. It only needs the resolved interactive executable; production
	// launches always carry an absolute task prompt root.
	if strings.TrimSpace(inv.TaskPromptRoot) == "" {
		return ports.ReviewCommandSpec{Argv: []string{binary}}, nil
	}
	env, err := r.prepareEnvironment(inv)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	envVars := env.TUIEnvironment()
	envVars["AO_DATA_DIR"] = env.DataDir
	envVars["AO_REVIEW_GATEWAY_MANIFEST"] = env.ManifestPath
	return ports.ReviewCommandSpec{
		Argv:             []string{binary, "--bare", "--approval-mode", "plan"},
		Env:              envVars,
		InitialMessage:   inv.Prompt,
		WorkingDirectory: env.WorkingDirectory,
	}, nil
}

// ReviewMessage reuses AO's normal pane injection for subsequent passes.
func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewProcessReusable returns false because Qwen's gateway manifest is fixed
// in the launch environment. A new review task needs a fresh process with a
// fresh AO_REVIEW_GATEWAY_MANIFEST value.
func (*Reviewer) ReviewProcessReusable() bool { return false }

// ReviewCancel matches the pinned Qwen TUI behavior: one Escape aborts the
// active turn without exiting the long-lived process. Ctrl-C is a quit action.
func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelEscape, Interrupts: 1}, nil
}

func (r *Reviewer) prepareEnvironment(inv ports.ReviewInvocation) (reviewgateway.Environment, error) {
	dataDir := inv.DataDir
	if strings.TrimSpace(dataDir) == "" {
		return reviewgateway.Environment{}, errors.New("qwen reviewer: AO data directory is required")
	}
	manifest := reviewgateway.Manifest{
		ReviewerID: inv.ReviewerID, WorkerSessionID: inv.WorkerSessionID,
		WorkspacePath: inv.WorkspacePath, TaskPromptRoot: inv.TaskPromptRoot,
		Tasks: reviewGatewayTasks(inv),
	}
	env, err := reviewgateway.PrepareEnvironment(dataDir, manifest)
	if err != nil {
		return reviewgateway.Environment{}, fmt.Errorf("qwen reviewer: prepare gateway environment: %w", err)
	}
	return env, nil
}

func reviewGatewayTasks(inv ports.ReviewInvocation) []reviewgateway.Task {
	if len(inv.ReviewQueue) == 0 {
		return []reviewgateway.Task{{
			RunID: inv.RunID, PRURL: inv.PRURL, TargetSHA: inv.TargetSHA,
			TaskPromptFile: inv.TaskPromptFile,
		}}
	}
	tasks := make([]reviewgateway.Task, 0, len(inv.ReviewQueue))
	for _, task := range inv.ReviewQueue {
		tasks = append(tasks, reviewgateway.Task{
			RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA,
			TaskPromptFile: inv.TaskPromptFile,
		})
	}
	return tasks
}
