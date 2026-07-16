package daemon

import (
	"context"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	trackerintake "github.com/aoagents/agent-orchestrator/backend/internal/observe/trackerintake"
	"github.com/aoagents/agent-orchestrator/backend/internal/scmregistry"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startTrackerIntake wires the opt-in GitHub issue-intake loop. The observer
// always runs — Poll re-reads each project's config on every tick and skips
// projects with intake disabled, so a project enabling intake after daemon
// boot is picked up on the next tick without a restart. The adapter itself
// stays lazy so daemon readiness is not blocked by credential probing or a gh
// CLI call, and no token is resolved until some enabled project is actually
// polled.
func startTrackerIntake(ctx context.Context, store *sqlite.Store, sessions *sessionsvc.Service, providers scmregistry.ProjectProviderResolver, logger *slog.Logger) <-chan struct{} {
	bundle, err := providers.Resolve(ctx, legacyGitHubProject())
	if err != nil {
		logger.Warn("tracker intake disabled: GitHub provider setup failed", "err", err)
		return closedDone()
	}
	resolver := trackerintake.SingleTrackerResolver{
		Provider: domain.TrackerProviderGitHub,
		Adapter:  bundle.Tracker,
	}
	observer := trackerintake.New(resolver, store, sessions, trackerintake.Config{Logger: logger})
	return observer.Start(ctx)
}
