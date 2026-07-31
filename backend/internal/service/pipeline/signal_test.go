package pipelinesvc_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// newSignalService stands up a real store with one project and one run whose
// stages carry the outcomes the caller asked for, keyed by stage id.
func newSignalService(t *testing.T, outcomes map[string]pipeline.Outcome) *pipelinesvc.Service {
	t.Helper()
	s, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.UpsertProject(ctx, domain.ProjectRecord{ID: "proj", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	stages := make(map[string]*pipeline.StageState, len(outcomes))
	for id, outcome := range outcomes {
		stages[id] = &pipeline.StageState{ID: id, Outcome: outcome, Attempt: 1, EnteredVia: pipeline.EntryTrigger, StartedAt: now}
	}
	run := pipeline.RunState{
		RunID:        "run-1",
		ProjectID:    "proj",
		PipelineID:   "pl-1",
		PipelineName: "review",
		Subject:      pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj"},
		Status:       pipeline.RunRunning,
		Stages:       stages,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	return pipelinesvc.New(s)
}

func TestSignalStage_DoneIsAppendedAndReadBack(t *testing.T) {
	svc := newSignalService(t, map[string]pipeline.Outcome{"review": pipeline.OutcomeRunning})
	ctx := context.Background()

	if err := svc.SignalStage(ctx, "run-1", "review", pipeline.SignalDone, ""); err != nil {
		t.Fatalf("SignalStage: %v", err)
	}

	got, ok, err := svc.LatestStageSignal(ctx, "run-1", "review")
	if err != nil || !ok {
		t.Fatalf("LatestStageSignal ok=%v err=%v", ok, err)
	}
	if got.Kind != pipeline.SignalDone || got.RunID != "run-1" || got.StageID != "review" {
		t.Fatalf("signal = %+v", got)
	}
	if got.CreatedAt.IsZero() {
		t.Fatal("signal createdAt is zero")
	}
}

func TestSignalStage_FailPersistsReason(t *testing.T) {
	svc := newSignalService(t, map[string]pipeline.Outcome{"review": pipeline.OutcomeRunning})
	ctx := context.Background()

	if err := svc.SignalStage(ctx, "run-1", "review", pipeline.SignalFail, "cannot reach the API"); err != nil {
		t.Fatalf("SignalStage: %v", err)
	}

	got, ok, err := svc.LatestStageSignal(ctx, "run-1", "review")
	if err != nil || !ok {
		t.Fatalf("LatestStageSignal ok=%v err=%v", ok, err)
	}
	if got.Kind != pipeline.SignalFail || got.Reason != "cannot reach the API" {
		t.Fatalf("signal = %+v", got)
	}
}

// The latest signal wins: a stage nudged after signalling fail can settle done.
func TestSignalStage_LatestSignalWins(t *testing.T) {
	svc := newSignalService(t, map[string]pipeline.Outcome{"review": pipeline.OutcomeRunning})
	ctx := context.Background()

	if err := svc.SignalStage(ctx, "run-1", "review", pipeline.SignalFail, "first"); err != nil {
		t.Fatalf("first SignalStage: %v", err)
	}
	if err := svc.SignalStage(ctx, "run-1", "review", pipeline.SignalDone, ""); err != nil {
		t.Fatalf("second SignalStage: %v", err)
	}

	got, _, err := svc.LatestStageSignal(ctx, "run-1", "review")
	if err != nil {
		t.Fatalf("LatestStageSignal: %v", err)
	}
	if got.Kind != pipeline.SignalDone {
		t.Fatalf("kind = %q, want done", got.Kind)
	}
}

func TestSignalStage_Rejections(t *testing.T) {
	tests := []struct {
		name    string
		runID   pipeline.RunID
		stageID string
		kind    pipeline.SignalKind
		want    error
	}{
		{"unknown run", "run-nope", "review", pipeline.SignalDone, pipelinesvc.ErrRunNotFound},
		{"unknown stage", "run-1", "nope", pipeline.SignalDone, pipelinesvc.ErrStageNotFound},
		{"pending stage", "run-1", "publish", pipeline.SignalDone, pipelinesvc.ErrStageNotRunning},
		{"settled stage", "run-1", "lint", pipeline.SignalDone, pipelinesvc.ErrStageNotRunning},
		{"unknown kind", "run-1", "review", pipeline.SignalKind("maybe"), pipelinesvc.ErrUnknownSignalKind},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := newSignalService(t, map[string]pipeline.Outcome{
				"review":  pipeline.OutcomeRunning,
				"publish": pipeline.OutcomePending,
				"lint":    pipeline.OutcomeSucceeded,
			})
			err := svc.SignalStage(context.Background(), tc.runID, tc.stageID, tc.kind, "")
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if _, ok, _ := svc.LatestStageSignal(context.Background(), tc.runID, tc.stageID); ok {
				t.Fatal("rejected signal was persisted anyway")
			}
		})
	}
}

func TestLatestStageSignal_NoSignalYet(t *testing.T) {
	svc := newSignalService(t, map[string]pipeline.Outcome{"review": pipeline.OutcomeRunning})
	_, ok, err := svc.LatestStageSignal(context.Background(), "run-1", "review")
	if err != nil {
		t.Fatalf("LatestStageSignal: %v", err)
	}
	if ok {
		t.Fatal("ok = true for a stage that never signalled")
	}
}
