package store

import (
	"context"
	"fmt"
	"sort"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// HydratePipelineEngineState rebuilds a project's pipeline.EngineState from the
// store so a freshly constructed per-project engine (spec §4b T5) resumes with
// existing runs, loop pointers, and history instead of an empty state.
//
// Terminal runs feed historySummaries; the latest non-terminal run on each loop
// key wins currentRunByLoop. Rows come back newest-first, so we walk them
// oldest-first to keep each loop's history in chronological order and let the
// newest live run win its loop key.
func (s *Store) HydratePipelineEngineState(ctx context.Context, projectID domain.ProjectID) (pipeline.EngineState, error) {
	state := pipeline.EmptyEngineState()
	rows, err := s.qr.ListPipelineRuns(ctx, gen.ListPipelineRunsParams{ProjectID: projectID, Lim: -1})
	if err != nil {
		return state, fmt.Errorf("hydrate pipeline runs for %s: %w", projectID, err)
	}
	for i := len(rows) - 1; i >= 0; i-- {
		run, err := hydrateRun(ctx, s.qr, rows[i])
		if err != nil {
			return pipeline.EmptyEngineState(), err
		}
		state.Runs[run.RunID] = run
		key := pipeline.LoopKey(run.SessionID, run.PipelineName)
		if run.LoopState.IsTerminal() {
			state.HistorySummaries[key] = append(state.HistorySummaries[key], summarizeRun(run))
		} else {
			state.CurrentRunByLoop[key] = run.RunID
		}
	}
	return state, nil
}

// summarizeRun builds the compact RunSummary used by cross-run stall detection.
// Fingerprints are deduped and sorted so convergence comparison is order-stable.
func summarizeRun(run pipeline.RunState) pipeline.RunSummary {
	return pipeline.RunSummary{
		RunID:             run.RunID,
		LoopState:         run.LoopState,
		TerminationReason: run.TerminationReason,
		HeadSHA:           run.HeadSHA,
		LoopRounds:        run.LoopRounds,
		Fingerprints:      dedupeSorted(run.Fingerprints),
		CreatedAt:         run.CreatedAt,
	}
}

func dedupeSorted(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
