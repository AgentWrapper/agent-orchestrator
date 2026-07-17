// Package devimport exposes developer project-registry import operations
// through the daemon service boundary.
package devimport

import (
	"context"
	"fmt"

	engine "github.com/aoagents/agent-orchestrator/backend/internal/devimport"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// Store is the live target store used by the daemon.
type Store interface {
	engine.Store
}

// RunInput configures one project-registry import.
type RunInput struct {
	SourceDataDir string
	DryRun        bool
}

// Service is the controller-facing dev import contract.
type Service interface {
	RunProjects(ctx context.Context, in RunInput) (engine.Report, error)
}

// Deps bundles the service dependencies.
type Deps struct {
	Store         Store
	TargetDataDir string
}

// Manager implements Service over the daemon's live store.
type Manager struct {
	store         Store
	targetDataDir string
}

var _ Service = (*Manager)(nil)

// New constructs the dev import service.
func New(deps Deps) *Manager {
	return &Manager{store: deps.Store, targetDataDir: deps.TargetDataDir}
}

// RunProjects reads the source AO database read-only and plans or writes into
// the daemon's live store.
func (m *Manager) RunProjects(ctx context.Context, in RunInput) (engine.Report, error) {
	source, err := sqlite.OpenReadOnly(ctx, in.SourceDataDir)
	if err != nil {
		return engine.Report{}, fmt.Errorf("open source store: %w", err)
	}
	defer func() { _ = source.Close() }()

	return engine.Run(ctx, source, m.store, engine.Options{
		SourceDataDir: in.SourceDataDir,
		TargetDataDir: m.targetDataDir,
		DryRun:        in.DryRun,
	})
}
