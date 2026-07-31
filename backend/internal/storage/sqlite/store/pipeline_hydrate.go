package store

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// HydratePipelineEngineState returns the runs a freshly constructed
// per-project engine has to take back over: the unsettled ones, oldest first.
//
// Settled runs are deliberately absent. v2 runs are independent snapshots with
// no cross-run history to rebuild (decision D1), so a settled run is only ever
// read back through the run list on the board.
//
// Stages persisted as running whose in-process handle is gone are reconciled
// by the engine on start (decision D16); the store hands them back exactly as
// they were written.
func (s *Store) HydratePipelineEngineState(ctx context.Context, projectID domain.ProjectID) ([]pipeline.RunState, error) {
	rows, err := s.qr.ListUnsettledPipelineRuns(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("hydrate pipeline runs for %s: %w", projectID, err)
	}
	return hydrateRuns(ctx, s.qr, rows)
}
