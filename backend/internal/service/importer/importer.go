// Package importer is the controller-facing service for the legacy-AO import.
// It wraps the internal/legacyimport engine with a detection probe (is a legacy
// install present?) and a trigger that runs the import through the live daemon's
// store, so the daemon stays the sole writer. Whether to PROMPT for the import
// is the desktop app's job (the app-state.json migration marker), so this probe
// reports only physical availability, not "already imported".
package importer

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/legacyimport"
)

// Store is the storage slice the import runs through; *sqlite.Store satisfies it.
type Store interface {
	legacyimport.Store
}

// Status reports whether a legacy AO install is physically present to import.
type Status struct {
	Available  bool   `json:"available"`
	LegacyRoot string `json:"legacyRoot"`
}

// Service is the controller-facing import contract.
type Service interface {
	Status(ctx context.Context) (Status, error)
	Run(ctx context.Context) (legacyimport.Report, error)
}

// Deps bundles the import service's dependencies.
type Deps struct {
	// Store is the rewrite's durable store (the daemon's shared *sqlite.Store).
	Store Store
	// Root overrides the legacy AO root to read. Empty -> the default.
	Root string
}

// Manager implements Service over the daemon's store.
type Manager struct {
	store Store
	root  string
}

var _ Service = (*Manager)(nil)

// New constructs the import service. An empty Root falls back to the default.
func New(deps Deps) *Manager {
	root := deps.Root
	if root == "" {
		root = legacyimport.DefaultLegacyRootDir()
	}
	return &Manager{store: deps.Store, root: root}
}

// Status reports availability only: legacy data present at the root. It never
// errors on a missing legacy store; that is simply "not available".
func (m *Manager) Status(_ context.Context) (Status, error) {
	return Status{Available: legacyimport.HasLegacyData(m.root), LegacyRoot: m.root}, nil
}

// Run executes the import through the daemon's store. Idempotent: the engine
// skips rows that already exist. Legacy files are never modified.
func (m *Manager) Run(ctx context.Context) (legacyimport.Report, error) {
	return legacyimport.Run(ctx, m.store, legacyimport.Options{Root: m.root})
}
