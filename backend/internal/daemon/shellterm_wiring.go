package daemon

import (
	"context"
	"errors"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
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
	sessions sessionGetter,
	log *slog.Logger,
) *shelltermsvc.Service {
	svc := shelltermsvc.NewService(
		runtime,
		store,
		&projectRootLocator{projects: projects},
		&sessionWorkspaceLocator{sessions: sessions},
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

// sessionGetter is the slice of the session service the shell terminal wiring
// needs: a session id in, its full read model out. *sessionsvc.Service
// satisfies this already.
type sessionGetter interface {
	Get(ctx context.Context, id domain.SessionID) (domain.Session, error)
}

// sessionWorkspaceLocator adapts the session service to the shell terminal
// service's session-scoping lookup, so a shell opened from a session view
// starts in that session's own worktree rather than the project root.
type sessionWorkspaceLocator struct {
	sessions sessionGetter
}

// SessionWorkspacePath resolves a session id to its current workspace path.
// found is false, with a nil error, for an unknown session id — the shell
// terminal service turns that into a 404 the same way an unknown project does.
// A found session with no workspace path yet (still spawning) reports "", true
// so the caller can fall back to project scope instead of erroring.
func (l *sessionWorkspaceLocator) SessionWorkspacePath(ctx context.Context, id domain.SessionID) (string, bool, error) {
	if l.sessions == nil {
		return "", false, nil
	}
	sess, err := l.sessions.Get(ctx, id)
	if err != nil {
		var apiErr *apierr.Error
		if errors.As(err, &apiErr) && apiErr.Kind == apierr.KindNotFound {
			return "", false, nil
		}
		return "", false, err
	}
	return sess.Metadata.WorkspacePath, true, nil
}
