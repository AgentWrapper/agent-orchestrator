package daemon

import (
	"context"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

const orchestratorSupervisorInterval = 30 * time.Second

type orchestratorProjectLister interface {
	List(context.Context) ([]projectsvc.Summary, error)
}

type orchestratorEnsurer interface {
	SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
}

func startOrchestratorSupervisor(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, interval time.Duration, log *slog.Logger) <-chan struct{} {
	done := make(chan struct{})
	if log == nil {
		log = slog.Default()
	}
	if interval <= 0 {
		interval = orchestratorSupervisorInterval
	}
	go func() {
		defer close(done)
		ensureOrchestrators(ctx, projects, sessions, log)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ensureOrchestrators(ctx, projects, sessions, log)
			}
		}
	}()
	return done
}

func ensureOrchestrators(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, log *slog.Logger) {
	summaries, err := projects.List(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("orchestrator-supervisor: list projects failed", "err", err)
		return
	}
	for _, project := range summaries {
		if ctx.Err() != nil {
			return
		}
		if project.ID == "" {
			continue
		}
		if _, err := sessions.SpawnOrchestrator(ctx, project.ID, false); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("orchestrator-supervisor: ensure orchestrator failed", "project", project.ID, "err", err)
		}
	}
}
