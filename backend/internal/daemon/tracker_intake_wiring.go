package daemon

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	trackerintake "github.com/aoagents/agent-orchestrator/backend/internal/observe/trackerintake"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/scmregistry"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startTrackerIntake wires the opt-in project-scoped issue-intake loop. The observer
// always runs — Poll re-reads each project's config on every tick and skips
// projects with intake disabled, so a project enabling intake after daemon
// boot is picked up on the next tick without a restart. Provider resolution
// stays lazy and happens independently for each enabled project.
func startTrackerIntake(ctx context.Context, store *sqlite.Store, sessions *sessionsvc.Service, providers scmregistry.ProjectProviderResolver, logger *slog.Logger) <-chan struct{} {
	resolver := projectTrackerResolver{providers: providers}
	observer := trackerintake.New(resolver, store, sessions, trackerintake.Config{Logger: logger})
	return observer.Start(ctx)
}

type projectTrackerResolver struct {
	providers scmregistry.ProjectProviderResolver
}

func (r projectTrackerResolver) Resolve(ctx context.Context, project domain.ProjectRecord) (ports.Tracker, error) {
	bundle, err := r.providers.Resolve(ctx, project)
	if err != nil {
		return nil, err
	}
	if bundle.Tracker == nil {
		return nil, fmt.Errorf("tracker intake: provider returned no tracker")
	}
	return bundle.Tracker, nil
}
