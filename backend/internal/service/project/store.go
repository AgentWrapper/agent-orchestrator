package project

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the durable project persistence surface required by Service.
type Store interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	FindProjectByPath(ctx context.Context, path string) (domain.ProjectRecord, bool, error)
	UpsertProject(ctx context.Context, row domain.ProjectRecord) error
	UpsertWorkspaceProject(ctx context.Context, row domain.ProjectRecord, repos []domain.WorkspaceRepoRecord) error
	ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error)
	RenameProject(ctx context.Context, id string, displayName string) (bool, error)
	ArchiveProject(ctx context.Context, id string, at time.Time) (bool, error)
}
