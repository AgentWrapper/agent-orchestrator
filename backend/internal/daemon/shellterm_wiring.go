package daemon

import (
	"context"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	shelltermsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startShellTerminals builds the standalone shell terminal service and sweeps
// any terminals left behind by a previous app run.
//
// The sweep runs at boot, before the server serves, for the same reason session
// reconciliation does: a client that connects first would otherwise see — and
// try to attach to — shells belonging to an app that is already gone.
func startShellTerminals(
	ctx context.Context,
	cfg config.Config,
	runtime shelltermsvc.ShellRuntime,
	store *sqlite.Store,
	projects projectsvc.Manager,
	log *slog.Logger,
) *shelltermsvc.Service {
	svc := shelltermsvc.NewService(
		runtime,
		store,
		&projectRootLocator{projects: projects},
		cfg.DataDir,
		cfg.AppRunID,
		log,
	)
	// Best-effort: a failed sweep must never block boot. The rows survive and
	// the next boot retries.
	if _, err := svc.ReapShellTerminalsFromPreviousAppRuns(ctx); err != nil {
		log.Warn("reaping shell terminals from previous app runs failed", "err", err)
	}
	return svc
}

// projectRootLocator adapts the project service to the narrow lookup the shell
// terminal service needs: an id in, a directory out.
type projectRootLocator struct {
	projects projectsvc.Manager
}

// ProjectRoot returns the project's path, or "" when no such project exists so
// the caller can answer 404. A degraded project (its config failed to load)
// still has a usable path on disk, and a shell in it is exactly the tool a user
// would want to fix it with — so degraded is resolved, not rejected.
func (l *projectRootLocator) ProjectRoot(ctx context.Context, id domain.ProjectID) (string, error) {
	if l.projects == nil {
		return "", nil
	}
	res, err := l.projects.Get(ctx, id)
	if err != nil {
		return "", err
	}
	switch {
	case res.Project != nil:
		return res.Project.Path, nil
	case res.Degraded != nil:
		return res.Degraded.Path, nil
	default:
		return "", nil
	}
}
