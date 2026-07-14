package review

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

const cancelInterruptDelay = 150 * time.Millisecond

// Launcher spawns, re-notifies, and probes a reviewer over a worker's worktree.
// It is the side of the engine that talks to the reviewer registry and runtime;
// the engine owns the orchestration and persistence.
type Launcher interface {
	// Spawn launches a fresh reviewer and returns the runtime handle id of the
	// live pane (stable per worker, reused across passes).
	Spawn(ctx context.Context, spec LaunchSpec) (handleID string, err error)
	// Notify asks an already-running reviewer pane to review a new commit.
	Notify(ctx context.Context, handleID string, spec LaunchSpec) error
	// Alive reports whether a reviewer pane is still running.
	Alive(ctx context.Context, handleID string) (bool, error)
	// Cancel interrupts a running reviewer pane while keeping the terminal alive.
	Cancel(ctx context.Context, handleID string, harness domain.ReviewerHarness) error
}

// LaunchSpec is the engine's request to (re)launch a reviewer for one pass.
type LaunchSpec struct {
	RunID         string
	WorkerID      domain.SessionID
	Harness       domain.ReviewerHarness
	WorkspacePath string
	PRURL         string
	TargetSHA     string
	ReviewQueue   []ports.ReviewTask
	ReviewIndex   int
}

// reviewerRuntime is the runtime surface the launcher needs: create a pane,
// inject a message into a running pane, and probe liveness. The tmux runtime
// satisfies it.
type reviewerRuntime interface {
	Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error)
	Interrupt(ctx context.Context, handle ports.RuntimeHandle) error
	IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error)
	SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error
}

// agentLauncher resolves a reviewer adapter from the registry and drives the
// runtime. The reviewer reuses the worker's worktree (a fresh session worktree
// would branch off the default branch and so would not contain the PR changes).
type agentLauncher struct {
	reviewers ports.ReviewerResolver
	runtime   reviewerRuntime
}

type preLaunchReviewer interface {
	PreLaunch(ctx context.Context, inv ports.ReviewInvocation) error
}

// NewLauncher builds the production reviewer launcher.
func NewLauncher(reviewers ports.ReviewerResolver, runtime reviewerRuntime) Launcher {
	return &agentLauncher{reviewers: reviewers, runtime: runtime}
}

// reviewerHandleID is the stable runtime handle for a worker's reviewer pane, so
// one live reviewer is reused across passes.
func reviewerHandleID(workerID domain.SessionID) string {
	return "review-" + string(workerID)
}

func (l *agentLauncher) invocation(spec LaunchSpec) ports.ReviewInvocation {
	prompt, systemPrompt := reviewTexts(spec)
	return ports.ReviewInvocation{
		ReviewerID:      reviewerHandleID(spec.WorkerID),
		RunID:           spec.RunID,
		WorkerSessionID: spec.WorkerID,
		PRURL:           spec.PRURL,
		TargetSHA:       spec.TargetSHA,
		ReviewQueue:     spec.ReviewQueue,
		ReviewIndex:     spec.ReviewIndex,
		WorkspacePath:   spec.WorkspacePath,
		Prompt:          prompt,
		SystemPrompt:    systemPrompt,
	}
}

func (l *agentLauncher) Spawn(ctx context.Context, spec LaunchSpec) (string, error) {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return "", fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	handleID := reviewerHandleID(spec.WorkerID)
	inv := l.invocation(spec)
	if pl, ok := reviewer.(preLaunchReviewer); ok {
		if err := pl.PreLaunch(ctx, inv); err != nil {
			return "", fmt.Errorf("reviewer pre-launch: %w", err)
		}
	}
	cmd, err := reviewer.ReviewCommand(ctx, inv)
	if err != nil {
		return "", fmt.Errorf("reviewer command: %w", err)
	}
	handle, err := l.runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(handleID),
		WorkspacePath: spec.WorkspacePath,
		Argv:          cmd.Argv,
		Env:           pinnedEnv(cmd.Env),
	})
	if err != nil {
		return "", fmt.Errorf("reviewer runtime: %w", err)
	}
	return handle.ID, nil
}

// pinnedEnv returns the reviewer command's env with PATH pinned to the daemon's
// own directory, so the bare `ao` the reviewer runs (e.g. `ao review submit`)
// resolves to this daemon's CLI rather than a foreign `ao` first on the
// inherited PATH. Mirrors the worker-session pin in the session manager.
// Best-effort: an unpinnable daemon (not named "ao") keeps the inherited PATH.
func pinnedEnv(base map[string]string) map[string]string {
	path, err := sessionmanager.HookPATH(os.Executable, os.Getenv, base)
	if err != nil {
		return base
	}
	env := make(map[string]string, len(base)+1)
	for k, v := range base {
		env[k] = v
	}
	env["PATH"] = path
	return env
}

func (l *agentLauncher) Notify(ctx context.Context, handleID string, spec LaunchSpec) error {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	msg, err := reviewer.ReviewMessage(ctx, l.invocation(spec))
	if err != nil {
		return fmt.Errorf("reviewer message: %w", err)
	}
	if err := l.runtime.SendMessage(ctx, ports.RuntimeHandle{ID: handleID}, msg); err != nil {
		return fmt.Errorf("notify reviewer: %w", err)
	}
	return nil
}

func (l *agentLauncher) Alive(ctx context.Context, handleID string) (bool, error) {
	if handleID == "" {
		return false, nil
	}
	return l.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: handleID})
}

func (l *agentLauncher) Cancel(ctx context.Context, handleID string, harness domain.ReviewerHarness) error {
	if handleID == "" {
		return nil
	}
	reviewer, ok := l.reviewers.Reviewer(harness)
	if !ok {
		return fmt.Errorf("no reviewer adapter for harness %q", harness)
	}
	canceller, ok := reviewer.(ports.ReviewerCanceller)
	if !ok {
		return fmt.Errorf("reviewer adapter %q does not support cancellation", harness)
	}
	spec, err := canceller.ReviewCancel(ctx)
	if err != nil {
		return fmt.Errorf("reviewer cancel: %w", err)
	}
	switch spec.Mode {
	case ports.ReviewCancelInterrupt:
		interrupts := spec.Interrupts
		if interrupts <= 0 {
			interrupts = 1
		}
		for i := 0; i < interrupts; i++ {
			if err := l.runtime.Interrupt(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
				return err
			}
			if i < interrupts-1 {
				timer := time.NewTimer(cancelInterruptDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return ctx.Err()
				case <-timer.C:
				}
			}
		}
		return nil
	default:
		return fmt.Errorf("reviewer adapter %q returned unsupported cancel mode %q", harness, spec.Mode)
	}
}
