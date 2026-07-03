package daemon

// This file wires the cross-session collision (convergence) observer into daemon
// startup. The observer diffs each live session's worktree and detects when two
// parallel agents are editing overlapping code before either opens a PR, then
// nudges them through the same Lifecycle Manager the SCM lane uses.

import (
	"context"
	"log/slog"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/convergence"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startConvergenceObserver builds a read-only gitworktree differ over the same
// managed root and project→repo resolver the session workspace uses, then starts
// the convergence observer. A construction failure disables the lane (logged once)
// rather than failing daemon startup, mirroring startSCMObserver's posture.
func startConvergenceObserver(ctx context.Context, cfg config.Config, store *sqlite.Store, lcm *lifecycle.Manager, logger *slog.Logger) <-chan struct{} {
	differ, err := gitworktree.New(gitworktree.Options{
		ManagedRoot:  filepath.Join(cfg.DataDir, "worktrees"),
		RepoResolver: projectRepoResolver{store: store},
	})
	if err != nil {
		logger.Warn("convergence observer disabled: workspace differ setup failed", "err", err)
		return closedDone()
	}
	observer := convergence.New(differ, store, lcm, convergence.Config{Logger: logger})
	return observer.Start(ctx)
}
