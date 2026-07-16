package daemon

import (
	"context"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/observe/coordinatorwake"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func startCoordinatorWake(ctx context.Context, store *sqlite.Store, sessions *sessionsvc.Service, logger *slog.Logger) <-chan struct{} {
	return coordinatorwake.New(store, sessions, coordinatorwake.Config{Logger: logger}).Start(ctx)
}
