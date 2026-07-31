package pipelinesvc

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
)

// Signal path errors. The controller maps them onto the wire contract for
// POST /pipelines/runs/{runId}/stages/{stageId}/signal: 404, 404, 409, 400.
var (
	// ErrRunNotFound means no run carries the requested id.
	ErrRunNotFound = errors.New("pipeline run not found")
	// ErrStageNotFound means the run exists but declares no such stage.
	ErrStageNotFound = errors.New("pipeline stage not found")
	// ErrStageNotRunning means the stage is pending or already settled, so a
	// signal for it would settle nothing. A stage that signals twice while
	// running is fine (the latest wins); a stage that signals after settling
	// is a mistake worth reporting.
	ErrStageNotRunning = errors.New("pipeline stage is not running")
	// ErrUnknownSignalKind means the caller sent something other than done or
	// fail.
	ErrUnknownSignalKind = errors.New("unknown signal kind")
	// ErrStoreUnavailable means the service was built without a store, so
	// nothing can be persisted or read.
	ErrStoreUnavailable = errors.New("pipeline store unavailable")
)

// SignalStore is the persistence the signal path needs: the run to validate
// the target against, plus the append-only signal log.
type SignalStore interface {
	GetPipelineRun(ctx context.Context, id pipeline.RunID) (pipeline.RunState, bool, error)
	AppendPipelineStageSignal(ctx context.Context, sig pipeline.StageSignal) error
	LatestPipelineStageSignal(ctx context.Context, runID pipeline.RunID, stageID string) (pipeline.StageSignal, bool, error)
}

// SignalStage records one `ao pipeline done|fail` for a running stage. The
// signal is appended, never updated: the executor reads the latest row, so a
// second signal after a nudge supersedes the first without losing history.
func (s *Service) SignalStage(ctx context.Context, runID pipeline.RunID, stageID string, kind pipeline.SignalKind, reason string) error {
	if s.store == nil {
		return ErrStoreUnavailable
	}
	if !kind.IsKnown() {
		return fmt.Errorf("%w: %q", ErrUnknownSignalKind, kind)
	}
	run, ok, err := s.store.GetPipelineRun(ctx, runID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrRunNotFound, runID)
	}
	stage, ok := run.Stages[stageID]
	if !ok || stage == nil {
		return fmt.Errorf("%w: %s/%s", ErrStageNotFound, runID, stageID)
	}
	if stage.Outcome != pipeline.OutcomeRunning {
		return fmt.Errorf("%w: %s/%s is %s", ErrStageNotRunning, runID, stageID, stage.Outcome)
	}
	return s.store.AppendPipelineStageSignal(ctx, pipeline.StageSignal{
		RunID:     runID,
		StageID:   stageID,
		Kind:      kind,
		Reason:    reason,
		CreatedAt: time.Now().UTC(),
	})
}

// LatestStageSignal returns the newest signal for a (run, stage), ok=false
// when the stage has not signalled. This is the read side the agent executor
// polls to tell "the agent said it is done" from "the agent went quiet".
func (s *Service) LatestStageSignal(ctx context.Context, runID pipeline.RunID, stageID string) (pipeline.StageSignal, bool, error) {
	if s.store == nil {
		return pipeline.StageSignal{}, false, ErrStoreUnavailable
	}
	return s.store.LatestPipelineStageSignal(ctx, runID, stageID)
}

// The agent executor polls the Service for signals.
var _ executors.SignalReader = (*Service)(nil)

// LatestSignal is LatestStageSignal in the shape the agent executor's poll
// loop wants. That contract has no error channel, so a failed read is reported
// as "not signalled yet": the stage then settles on idle, exit or its deadline
// rather than on a read that did not happen.
func (s *Service) LatestSignal(runID pipeline.RunID, stageID string) (pipeline.StageSignal, bool) {
	sig, ok, err := s.LatestStageSignal(context.Background(), runID, stageID)
	if err != nil {
		return pipeline.StageSignal{}, false
	}
	return sig, ok
}
