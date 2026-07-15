package pipelinesvc

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// ---------------------------------------------------------------------------
// Test doubles: a real engine over a real store + a scripted executor, so the
// service's lifecycle mutations exercise the actual reducer transition (not a
// recorded-call fake) — the DoD's "route through the engine, assert state
// transition" requirement.
// ---------------------------------------------------------------------------

type fakeHandle struct {
	runID      pipeline.RunID
	stageRunID pipeline.StageRunID
	stageName  string
}

func (h fakeHandle) RunID() pipeline.RunID           { return h.runID }
func (h fakeHandle) StageRunID() pipeline.StageRunID { return h.stageRunID }
func (h fakeHandle) StageName() string               { return h.stageName }

// fakeExecutor keeps every stage "running" until the test marks an outcome.
type fakeExecutor struct {
	mu      sync.Mutex
	outcome map[string]executors.Outcome
	ready   map[string]bool
}

func newFakeExecutor() *fakeExecutor {
	return &fakeExecutor{outcome: map[string]executors.Outcome{}, ready: map[string]bool{}}
}

func (f *fakeExecutor) Start(_ context.Context, in executors.StartInput) (executors.Handle, error) {
	return fakeHandle{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}, nil
}

func (f *fakeExecutor) Poll(_ context.Context, h executors.Handle) (executors.Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ready[h.StageName()] {
		return f.outcome[h.StageName()], nil
	}
	return executors.Outcome{Status: executors.OutcomeRunning}, nil
}

func (f *fakeExecutor) Cancel(context.Context, executors.Handle) error { return nil }

func (f *fakeExecutor) fail(stage, msg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcome[stage] = executors.Outcome{Status: executors.OutcomeFailed, ErrorMessage: msg}
	f.ready[stage] = true
}

// staticEngines hands the same engine back for any project.
type staticEngines struct{ eng Engine }

func (s staticEngines) For(context.Context, domain.ProjectID) (Engine, error) { return s.eng, nil }

const reviewYAML = `name: review
stages:
  - name: review
    trigger:
      on: [manual]
    executor:
      kind: agent
      plugin: claude-code
      mode: review
`

const guardYAML = `name: guard
stages:
  - name: check
    trigger:
      on: [manual]
    executor:
      kind: agent
      plugin: claude-code
      mode: review
`

func newStore(t *testing.T, projectID string) *sqlite.Store {
	t.Helper()
	s, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.UpsertProject(context.Background(), domain.ProjectRecord{
		ID: projectID, Path: "/tmp/" + projectID, RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	return s
}

func newEngine(t *testing.T, store *sqlite.Store, projectID string, fake executors.StageExecutor) *engine.Engine {
	t.Helper()
	e := engine.New(engine.Config{
		ProjectID:    domain.ProjectID(projectID),
		Store:        store,
		Executors:    executors.NewSet(fake, fake, fake),
		TickInterval: time.Hour, // disable heartbeat; the test drives progress
	})
	if err := e.Start(context.Background()); err != nil {
		t.Fatalf("engine start: %v", err)
	}
	t.Cleanup(func() { _ = e.Stop(context.Background()) })
	return e
}

func newHarness(t *testing.T) (*Service, *engine.Engine, *sqlite.Store, *fakeExecutor) {
	t.Helper()
	store := newStore(t, "mer")
	fake := newFakeExecutor()
	eng := newEngine(t, store, "mer", fake)
	svc := New(store, staticEngines{eng: eng})
	return svc, eng, store, fake
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestTriggerAppearsInListAndCancelTransitions covers the manual-trigger →
// list → cancel path end to end: the trigger returns a run id, the run shows up
// in the list, and cancelling drives it to a terminal state that is persisted.
func TestTriggerAppearsInListAndCancelTransitions(t *testing.T) {
	ctx := context.Background()
	svc, _, store, _ := newHarness(t)

	if _, err := svc.CreateDefinition(ctx, "mer", reviewYAML); err != nil {
		t.Fatalf("create definition: %v", err)
	}

	runID, err := svc.TriggerRun(ctx, "mer", TriggerInput{Ref: "review", SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if runID == "" {
		t.Fatal("trigger returned empty run id")
	}

	runs, err := svc.ListRuns(ctx, "mer", pipeline.RunFilter{})
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 1 || runs[0].RunID != runID {
		t.Fatalf("runs = %+v, want the triggered run %s", runs, runID)
	}
	if runs[0].LoopState != pipeline.LoopRunning {
		t.Fatalf("triggered run loop state = %s, want running", runs[0].LoopState)
	}

	cancelled, err := svc.CancelRun(ctx, "mer", runID)
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if !cancelled.LoopState.IsTerminal() {
		t.Fatalf("cancelled run loop state = %s, want terminal", cancelled.LoopState)
	}
	// The transition is durable, not just reflected in the return value.
	persisted, ok, err := store.GetPipelineRun(ctx, runID)
	if err != nil || !ok {
		t.Fatalf("get persisted run: ok=%v err=%v", ok, err)
	}
	if persisted.LoopState != pipeline.LoopTerminated {
		t.Fatalf("persisted loop state = %s, want terminated", persisted.LoopState)
	}
}

// TestResumeReArmsFailedRun drives a stage to failure (stalling the run), then
// resumes through the service and asserts the run is running again.
func TestResumeReArmsFailedRun(t *testing.T) {
	ctx := context.Background()
	svc, eng, _, fake := newHarness(t)
	if _, err := svc.CreateDefinition(ctx, "mer", reviewYAML); err != nil {
		t.Fatalf("create definition: %v", err)
	}
	runID, err := svc.TriggerRun(ctx, "mer", TriggerInput{Ref: "review", SessionID: "mer-1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	// Fail the stage and drive one tick; the run stalls.
	fake.fail("review", "boom")
	eng.Tick()
	stalled, err := svc.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if stalled.LoopState != pipeline.LoopStalled {
		t.Fatalf("loop state after failure = %s, want stalled", stalled.LoopState)
	}

	resumed, err := svc.ResumeRun(ctx, "mer", runID)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if resumed.LoopState != pipeline.LoopRunning {
		t.Fatalf("loop state after resume = %s, want running", resumed.LoopState)
	}
	if st := resumed.Stages["review"]; st.Status != pipeline.StageStatusRunning {
		t.Fatalf("review stage after resume = %s, want running", st.Status)
	}
}

// TestUpdateDefinitionTerminatesInFlightRun asserts an edit dispatches
// CONFIG_CHANGED for the affected loop so the in-flight run of the old config
// terminates (spec §6).
func TestUpdateDefinitionTerminatesInFlightRun(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := newHarness(t)
	def, err := svc.CreateDefinition(ctx, "mer", reviewYAML)
	if err != nil {
		t.Fatalf("create definition: %v", err)
	}
	runID, err := svc.TriggerRun(ctx, "mer", TriggerInput{Ref: "review", SessionID: "mer-1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	if _, err := svc.UpdateDefinition(ctx, def.ID, reviewYAML); err != nil {
		t.Fatalf("update definition: %v", err)
	}

	run, err := svc.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if run.LoopState != pipeline.LoopTerminated || run.TerminationReason != pipeline.TerminationConfigChange {
		t.Fatalf("run after config change = %s/%s, want terminated/config_change", run.LoopState, run.TerminationReason)
	}
}

// TestUpdateRenameToTakenNameConflicts asserts renaming a definition to a name
// already used by another definition in the project is a 409 (mirroring create),
// not a raw 500 from the UNIQUE(project_id, name) constraint. Renaming to a free
// name still succeeds.
func TestUpdateRenameToTakenNameConflicts(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := newHarness(t)
	reviewDef, err := svc.CreateDefinition(ctx, "mer", reviewYAML)
	if err != nil {
		t.Fatalf("create review: %v", err)
	}
	if _, err := svc.CreateDefinition(ctx, "mer", guardYAML); err != nil {
		t.Fatalf("create guard: %v", err)
	}

	// Rename "review" -> "guard": collides with the second definition.
	_, err = svc.UpdateDefinition(ctx, reviewDef.ID, guardYAML)
	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindConflict || apiErr.Code != "PIPELINE_NAME_TAKEN" {
		t.Fatalf("rename-to-taken err = %v, want 409 PIPELINE_NAME_TAKEN", err)
	}

	// Renaming to a free name is allowed.
	freshYAML := "name: review-2\nstages:\n  - name: review\n    trigger:\n      on: [manual]\n    executor:\n      kind: agent\n      plugin: claude-code\n      mode: review\n"
	updated, err := svc.UpdateDefinition(ctx, reviewDef.ID, freshYAML)
	if err != nil {
		t.Fatalf("rename to free name: %v", err)
	}
	if updated.Name != "review-2" {
		t.Fatalf("updated name = %q, want review-2", updated.Name)
	}
}

// TestCreateDefinitionValidationPassesThrough asserts a semantic validation
// failure surfaces as a *pipeline.ValidationError carrying every issue.
func TestCreateDefinitionValidationPassesThrough(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := newHarness(t)

	_, err := svc.CreateDefinition(ctx, "mer", "name: \"\"\nstages: []\n")
	var verr *pipeline.ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("err = %v, want *pipeline.ValidationError", err)
	}
	if len(verr.Issues) < 2 {
		t.Fatalf("issues = %+v, want the name + stages problems", verr.Issues)
	}
}

// TestCreateDuplicateNameConflicts asserts a second definition with the same
// name in a project is rejected as a conflict.
func TestCreateDuplicateNameConflicts(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := newHarness(t)
	if _, err := svc.CreateDefinition(ctx, "mer", reviewYAML); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, err := svc.CreateDefinition(ctx, "mer", reviewYAML)
	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindConflict {
		t.Fatalf("err = %v, want conflict apierr", err)
	}
}

// TestTriggerUnknownRefNotFound asserts an unresolvable reference is a 404.
func TestTriggerUnknownRefNotFound(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := newHarness(t)
	_, err := svc.TriggerRun(ctx, "mer", TriggerInput{Ref: "nope"})
	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindNotFound {
		t.Fatalf("err = %v, want not-found apierr", err)
	}
}
