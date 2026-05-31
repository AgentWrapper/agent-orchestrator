// Package project owns the projects service contract: the Manager interface
// the HTTP layer calls and the request/response DTOs that cross it (dto.go).
//
// This is the pilot for the feature-package layout the backend is migrating
// toward: a resource's interface and DTOs live with the resource, not in a
// central catch-all. Controllers depend on project.Manager and nothing
// beneath it — whether the implementation reaches into the config registry,
// the lifecycle manager (to stop sessions on remove), or a workspace adapter
// (to destroy worktrees) is a private concern of the impl, which lands in a
// later handler-impl PR. This PR defines only the contract.
package project

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Manager is the inbound contract for the /api/v1/projects surface. One
// implementation (this package, later); the HTTP controller is the consumer.
type Manager interface {
	// List returns every registered project, including degraded entries
	// (those whose config failed to load but whose registry entry survives).
	List(ctx context.Context) ([]Summary, error)

	// Get returns one project, discriminating ok vs degraded via GetResult.
	Get(ctx context.Context, id domain.ProjectID) (GetResult, error)

	// Add registers a new project from a git repository path.
	Add(ctx context.Context, in AddInput) (Project, error)

	// UpdateConfig patches behaviour-only fields; identity fields are frozen.
	UpdateConfig(ctx context.Context, id domain.ProjectID, patch UpdateConfigInput) (Project, error)

	// Remove unregisters a project, stopping its sessions and reclaiming
	// managed workspaces.
	Remove(ctx context.Context, id domain.ProjectID) (RemoveResult, error)

	// Repair recovers a degraded project where automatic repair is available.
	Repair(ctx context.Context, id domain.ProjectID) (Project, error)

	// Reload invalidates cached config and re-scans the global registry.
	Reload(ctx context.Context) (ReloadResult, error)
}
