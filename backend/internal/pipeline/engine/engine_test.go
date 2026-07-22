package engine

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeHandle is a minimal executors.Handle the fake executor hands back.
type fakeHandle struct {
	runID      pipeline.RunID
	stageRunID pipeline.StageRunID
	stageName  string
}

func (h fakeHandle) RunID() pipeline.RunID           { return h.runID }
func (h fakeHandle) StageRunID() pipeline.StageRunID { return h.stageRunID }
func (h fakeHandle) StageName() string               { return h.stageName }

// fakeExecutor is a scripted StageExecutor keyed by stage name. Poll returns
// OutcomeRunning until the test marks the stage's outcome ready. It stands in for
// all three kind executors so any stage routes to it through executors.Set.
type fakeExecutor struct {
	mu        sync.Mutex
	startErr  map[string]error
	outcome   map[string]executors.Outcome
	ready     map[string]bool
	started   map[string]int
	cancelled map[string]int
	lastInput map[string]executors.StartInput
}

func newFakeExecutor() *fakeExecutor {
	return &fakeExecutor{
		startErr:  map[string]error{},
		outcome:   map[string]executors.Outcome{},
		ready:     map[string]bool{},
		started:   map[string]int{},
		cancelled: map[string]int{},
		lastInput: map[string]executors.StartInput{},
	}
}

func (f *fakeExecutor) Start(_ context.Context, in executors.StartInput) (executors.Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.startErr[in.Stage.Name]; err != nil {
		return nil, err
	}
	f.started[in.Stage.Name]++
	f.lastInput[in.Stage.Name] = in
	return fakeHandle{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}, nil
}

// completeStatus scripts a stage to complete emitting only {kind:"status"} status
// changes (no artifacts): a verify/summarize stage acting on upstream findings.
func (f *fakeExecutor) completeStatus(stage string, changes ...pipeline.FindingStatusChange) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcome[stage] = executors.Outcome{Status: executors.OutcomeCompleted, Verdict: pipeline.VerdictNeutral, StatusChanges: changes}
	f.ready[stage] = true
}

// upstreamInput returns the StartInput the stage was last started with, for
// asserting resolved upstream findings.
func (f *fakeExecutor) upstreamInput(stage string) executors.StartInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastInput[stage]
}

func (f *fakeExecutor) Poll(_ context.Context, h executors.Handle) (executors.Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ready[h.StageName()] {
		return f.outcome[h.StageName()], nil
	}
	return executors.Outcome{Status: executors.OutcomeRunning}, nil
}

func (f *fakeExecutor) Cancel(_ context.Context, h executors.Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled[h.StageName()]++
	return nil
}

func (f *fakeExecutor) complete(stage string, verdict pipeline.Verdict, arts ...pipeline.ArtifactInput) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcome[stage] = executors.Outcome{Status: executors.OutcomeCompleted, Verdict: verdict, Artifacts: arts}
	f.ready[stage] = true
}

func (f *fakeExecutor) fail(stage, msg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcome[stage] = executors.Outcome{Status: executors.OutcomeFailed, ErrorMessage: msg}
	f.ready[stage] = true
}

func (f *fakeExecutor) startCount(stage string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.started[stage]
}

func (f *fakeExecutor) cancelCount(stage string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cancelled[stage]
}

// captureSink records observation names so tests can assert lifecycle signals
// fired. Safe for the actor + test goroutines.
type captureSink struct {
	mu    sync.Mutex
	names []string
}

func (c *captureSink) Observe(name string, _ map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.names = append(c.names, name)
}

func (c *captureSink) count(name string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, got := range c.names {
		if got == name {
			n++
		}
	}
	return n
}

// monotonicClock hands out strictly increasing timestamps so persisted runs sort
// deterministically on hydrate. Only the actor goroutine calls now().
type monotonicClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *monotonicClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(time.Millisecond)
	return c.t
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

func agentStage(name string, dependsOn ...string) pipeline.Stage {
	return pipeline.Stage{
		Name:      name,
		Trigger:   pipeline.StageTrigger{On: []pipeline.StageTriggerEvent{pipeline.TriggerManual}},
		Executor:  pipeline.StageExecutor{Kind: pipeline.ExecutorAgent, Plugin: "claude-code", Mode: pipeline.ModeReview},
		DependsOn: dependsOn,
	}
}

func pipelineOf(name string, maxConcurrent int, stages ...pipeline.Stage) pipeline.Pipeline {
	p := pipeline.Pipeline{ID: pipeline.ID("pl-" + name), Name: name, Scope: pipeline.ScopeWorker, Stages: stages}
	if maxConcurrent > 0 {
		mc := maxConcurrent
		p.MaxConcurrentStages = &mc
	}
	return p
}

func finding(title string) pipeline.ArtifactInput {
	return pipeline.ArtifactInput{
		Kind: pipeline.ArtifactKindFinding, FilePath: "main.go", StartLine: 1, EndLine: 2,
		Title: title, Category: "correctness", Severity: pipeline.SeverityError,
	}
}

func newTestStore(t *testing.T, projectID string) *sqlite.Store {
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

// newTestEngine builds a started engine over a real store + the given fake
// executor, with the internal ticker disabled so tests drive Tick() explicitly.
func newTestEngine(t *testing.T, projectID string, store *sqlite.Store, fake executors.StageExecutor, sink ObservationSink) *Engine {
	t.Helper()
	clk := &monotonicClock{t: time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)}
	e := New(Config{
		ProjectID:    domain.ProjectID(projectID),
		Store:        store,
		Executors:    executors.NewSet(fake, fake, fake),
		Sink:         sink,
		Clock:        clk.now,
		TickInterval: time.Hour, // disable the internal heartbeat; tests call Tick()
	})
	if err := e.Start(context.Background()); err != nil {
		t.Fatalf("engine start: %v", err)
	}
	t.Cleanup(func() { _ = e.Stop(context.Background()) })
	return e
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestSingleStageRunEndToEnd drives one agent stage through the REAL engine loop:
// trigger -> START_STAGE -> STAGE_STARTED -> poll completes -> exit predicate ->
// done, then asserts the persisted run, its artifact, and loop-state derivation
// on a fresh hydrate.
func TestSingleStageRunEndToEnd(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("review", 1, agentStage("review"))
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	// After trigger the stage is running and persisted.
	if got := e.State().Runs[runID].Stages["review"].Status; got != pipeline.StageStatusRunning {
		t.Fatalf("stage status after trigger = %s, want running", got)
	}
	if fake.startCount("review") != 1 {
		t.Fatalf("review started %d times, want 1", fake.startCount("review"))
	}

	// Complete the stage; one tick drives it through to a done run.
	fake.complete("review", pipeline.VerdictPass, finding("bug"))
	e.Tick()

	run := e.State().Runs[runID]
	if run.LoopState != pipeline.LoopDone {
		t.Fatalf("loop state = %s, want done", run.LoopState)
	}
	if st := run.Stages["review"]; st.Status != pipeline.StageStatusSucceeded || st.Verdict != pipeline.VerdictPass {
		t.Fatalf("review stage = %+v, want succeeded/pass", st)
	}

	// Persisted run + artifact.
	persisted, ok, err := store.GetPipelineRun(ctx, runID)
	if err != nil || !ok {
		t.Fatalf("get persisted run: ok=%v err=%v", ok, err)
	}
	if persisted.LoopState != pipeline.LoopDone {
		t.Fatalf("persisted loop state = %s, want done", persisted.LoopState)
	}
	if len(persisted.Findings) != 1 || persisted.Findings[0].Title != "bug" || persisted.Findings[0].Fingerprint == "" {
		t.Fatalf("persisted findings = %+v, want one fingerprinted finding", persisted.Findings)
	}

	// Loop-state derivation: a fresh hydrate rebuilds the terminal run into
	// history with the loop pointer freed (v1 derives loop state from runs, no
	// loop table).
	hydrated, err := store.HydratePipelineEngineState(ctx, "mer")
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	key := pipeline.LoopKey("mer-1", "review")
	if _, live := hydrated.CurrentRunByLoop[key]; live {
		t.Fatalf("terminal run must not hold a live loop pointer")
	}
	if h := hydrated.HistorySummaries[key]; len(h) != 1 || h[0].RunID != runID || h[0].LoopState != pipeline.LoopDone {
		t.Fatalf("history summaries = %+v, want one done run", h)
	}
}

// TestMultiStageDAGWithFailureAndResume runs a build->test->deploy DAG where test
// fails (cascade-skipping deploy and stalling the run), then resumes: test is
// re-armed, deploy is revived, and the run converges to done.
func TestMultiStageDAGWithFailureAndResume(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("ci", 2, agentStage("build"), agentStage("test", "build"), agentStage("deploy", "test"))
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	// Only build is eligible at trigger (test/deploy depend upstream).
	if fake.startCount("build") != 1 || fake.startCount("test") != 0 {
		t.Fatalf("initial starts: build=%d test=%d, want 1/0", fake.startCount("build"), fake.startCount("test"))
	}

	fake.complete("build", pipeline.VerdictPass)
	e.Tick() // build succeeds -> test starts
	if fake.startCount("test") != 1 {
		t.Fatalf("test started %d times after build, want 1", fake.startCount("test"))
	}

	fake.fail("test", "boom")
	e.Tick() // test fails -> deploy cascade-skipped -> run stalls
	run := e.State().Runs[runID]
	if run.LoopState != pipeline.LoopStalled {
		t.Fatalf("loop state after test failure = %s, want stalled", run.LoopState)
	}
	if run.Stages["test"].Status != pipeline.StageStatusFailed {
		t.Fatalf("test status = %s, want failed", run.Stages["test"].Status)
	}
	if run.Stages["deploy"].Status != pipeline.StageStatusSkipped {
		t.Fatalf("deploy status = %s, want skipped", run.Stages["deploy"].Status)
	}
	if fake.startCount("deploy") != 0 {
		t.Fatalf("deploy must not have started before resume")
	}

	// Recover: test now passes on the next attempt.
	fake.complete("test", pipeline.VerdictPass)
	e.Resume(runID)
	if run := e.State().Runs[runID]; run.LoopState != pipeline.LoopRunning {
		t.Fatalf("loop state after resume = %s, want running", run.LoopState)
	}
	if fake.startCount("test") != 2 {
		t.Fatalf("test restarted %d times, want 2 (attempt++ on resume)", fake.startCount("test"))
	}

	e.Tick() // test succeeds -> deploy (revived) starts
	if fake.startCount("deploy") != 1 {
		t.Fatalf("deploy started %d times after resume, want 1", fake.startCount("deploy"))
	}

	fake.complete("deploy", pipeline.VerdictPass)
	e.Tick() // deploy succeeds -> all terminal -> done
	final := e.State().Runs[runID]
	if final.LoopState != pipeline.LoopDone {
		t.Fatalf("final loop state = %s, want done", final.LoopState)
	}
	for name, st := range final.Stages {
		if st.Status != pipeline.StageStatusSucceeded {
			t.Fatalf("stage %s = %s, want succeeded", name, st.Status)
		}
	}
	if got := final.Stages["test"].Attempt; got != 2 {
		t.Fatalf("test attempt = %d, want 2", got)
	}
}

// TestCancelMidFlight cancels a running stage: CANCEL_STAGE reaches the executor,
// the stage goes outdated, and the run terminates.
func TestCancelMidFlight(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	sink := &captureSink{}
	e := newTestEngine(t, "mer", store, fake, sink)

	p := pipelineOf("review", 1, agentStage("review"))
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if e.State().Runs[runID].Stages["review"].Status != pipeline.StageStatusRunning {
		t.Fatal("review must be running before cancel")
	}

	e.Cancel(runID, pipeline.TerminationManualCancel)

	run := e.State().Runs[runID]
	if run.LoopState != pipeline.LoopTerminated {
		t.Fatalf("loop state after cancel = %s, want terminated", run.LoopState)
	}
	if st := run.Stages["review"].Status; st != pipeline.StageStatusOutdated {
		t.Fatalf("review status after cancel = %s, want outdated", st)
	}
	if fake.cancelCount("review") != 1 {
		t.Fatalf("CANCEL_STAGE reached executor %d times, want 1", fake.cancelCount("review"))
	}
	if sink.count("pipeline.run.terminated") != 1 {
		t.Fatalf("run.terminated observed %d times, want 1", sink.count("pipeline.run.terminated"))
	}

	// A second cancel is a clean no-op (already terminal).
	e.Cancel(runID, pipeline.TerminationManualCancel)
	if fake.cancelCount("review") != 1 {
		t.Fatalf("redundant cancel re-cancelled the stage")
	}
}

// TestHydrateOnBoot reconstructs engine state from a populated store: a terminal
// run lands in history untouched, and a run left running by a prior process is
// failed by reconcile so it stalls.
func TestHydrateOnBoot(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, "mer")
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)

	done := pipelineOf("review", 1, agentStage("review"))
	terminalRun := pipeline.RunState{
		RunID: "run-done", PipelineID: done.ID, PipelineName: done.Name, SessionID: "mer-1",
		PipelineConfigSnapshot: done, HeadSHA: "sha0", LoopState: pipeline.LoopDone,
		TerminationReason: pipeline.TerminationCompleted, LoopRounds: 1,
		Stages:    map[string]pipeline.StageState{"review": {StageRunID: "sr-done", Status: pipeline.StageStatusSucceeded, Attempt: 1, Verdict: pipeline.VerdictPass, CompletedAt: &now}},
		CreatedAt: now, UpdatedAt: now,
	}
	crashed := pipelineOf("review", 1, agentStage("review"))
	runningRun := pipeline.RunState{
		RunID: "run-crashed", PipelineID: crashed.ID, PipelineName: crashed.Name, SessionID: "mer-2",
		PipelineConfigSnapshot: crashed, HeadSHA: "sha1", LoopState: pipeline.LoopRunning, LoopRounds: 1,
		Stages:    map[string]pipeline.StageState{"review": {StageRunID: "sr-run", Status: pipeline.StageStatusRunning, Attempt: 1, StartedAt: &now}},
		CreatedAt: now.Add(time.Minute), UpdatedAt: now.Add(time.Minute),
	}
	if err := store.SavePipelineRun(ctx, "mer", terminalRun); err != nil {
		t.Fatalf("seed terminal run: %v", err)
	}
	if err := store.SavePipelineRun(ctx, "mer", runningRun); err != nil {
		t.Fatalf("seed running run: %v", err)
	}

	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	// The terminal run stays in history; reconcile never touches it.
	if h := e.State().HistorySummaries[pipeline.LoopKey("mer-1", "review")]; len(h) != 1 || h[0].RunID != "run-done" {
		t.Fatalf("terminal run history = %+v, want one done run", h)
	}
	// The crash-surviving run's running stage is failed by reconcile and, being a
	// single-stage pipeline, the run stalls.
	crashedState := e.State().Runs["run-crashed"]
	if crashedState.LoopState != pipeline.LoopStalled {
		t.Fatalf("crashed run loop state = %s, want stalled", crashedState.LoopState)
	}
	if st := crashedState.Stages["review"].Status; st != pipeline.StageStatusFailed {
		t.Fatalf("crashed stage status = %s, want failed", st)
	}
	// Reconcile fails the stage without re-invoking the (gone) executor.
	if fake.startCount("review") != 0 {
		t.Fatalf("reconcile must not re-start a stage")
	}
}

// TestConcurrentDispatchesSerialize fires many triggers, ticks, and reads from
// separate goroutines. The actor loop serializes every mutation, so -race sees no
// data race and all runs converge to done.
func TestConcurrentDispatchesSerialize(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	// Every stage of every run shares the name "review", so one outcome script
	// drives them all once ticked.
	fake.complete("review", pipeline.VerdictPass)
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("review", 1, agentStage("review"))

	const n = 25
	var wg sync.WaitGroup
	runIDs := make([]pipeline.RunID, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: fmt.Sprintf("mer-%d", i), HeadSHA: "sha1"})
			if err != nil {
				t.Errorf("trigger %d: %v", i, err)
				return
			}
			runIDs[i] = id
			// Concurrently read state and tick to exercise serialization.
			_ = e.State()
			e.Tick()
		}(i)
	}
	wg.Wait()

	// Drain any stages that started after their goroutine's tick.
	for i := 0; i < 3; i++ {
		e.Tick()
	}

	state := e.State()
	if len(state.Runs) != n {
		t.Fatalf("runs = %d, want %d", len(state.Runs), n)
	}
	for i, id := range runIDs {
		run, ok := state.Runs[id]
		if !ok {
			t.Fatalf("run %d (%s) missing", i, id)
		}
		if run.LoopState != pipeline.LoopDone {
			t.Fatalf("run %d loop state = %s, want done", i, run.LoopState)
		}
	}
}

// TestStageTimeoutViaTick wedges a running stage whose executor never reports a
// terminal outcome and verifies the engine's tick heartbeat dispatches
// pipeline.Tick, fails the stage at its deadline, tears the executor handle
// down, and stalls the run instead of letting it sit running forever.
func TestStageTimeoutViaTick(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	stage := agentStage("review")
	ms := int64(1) // 1ms deadline; the monotonic clock advances well past it before the tick.
	stage.TimeoutMs = &ms
	p := pipelineOf("review", 1, stage)
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if e.State().Runs[runID].Stages["review"].Status != pipeline.StageStatusRunning {
		t.Fatal("review must be running before its deadline")
	}

	// The stage never completes. Tick until the clock advances strictly past the
	// deadline (the monotonic test clock steps 1ms per read, so the first tick can
	// land exactly on a 1ms deadline; "past" is strict).
	e.Tick()
	e.Tick()

	run := e.State().Runs[runID]
	if run.LoopState != pipeline.LoopStalled {
		t.Fatalf("loop state after timeout = %s, want stalled", run.LoopState)
	}
	if st := run.Stages["review"]; st.Status != pipeline.StageStatusFailed || !strings.Contains(st.ErrorMessage, "timed out") {
		t.Fatalf("review stage = %+v, want failed with a timeout message", st)
	}
	if fake.cancelCount("review") != 1 {
		t.Fatalf("timeout must tear the executor down: cancelCount=%d, want 1", fake.cancelCount("review"))
	}
}

// TestStageAutoRetryViaEngine drives a failing stage with a retry budget through
// the real engine: the engine re-starts it automatically and only finalizes the
// run as stalled once the budget is spent.
func TestStageAutoRetryViaEngine(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	stage := agentStage("review")
	r := 1 // 1 retry => 2 attempts total.
	stage.Retries = &r
	p := pipelineOf("review", 1, stage)
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	// Attempt 1 fails; the engine auto-retries and starts attempt 2.
	fake.fail("review", "boom")
	e.Tick()
	if fake.startCount("review") != 2 {
		t.Fatalf("review started %d times, want 2 (auto-retry)", fake.startCount("review"))
	}
	if got := e.State().Runs[runID]; got.LoopState != pipeline.LoopRunning {
		t.Fatalf("run should still be running after the first retry, got %s", got.LoopState)
	}

	// Attempt 2 also fails (the fake still reports the failed outcome); budget is
	// now spent, so the run finalizes as stalled.
	e.Tick()
	final := e.State().Runs[runID]
	if final.LoopState != pipeline.LoopStalled {
		t.Fatalf("loop state after exhausting retries = %s, want stalled", final.LoopState)
	}
	if got := final.Stages["review"]; got.Status != pipeline.StageStatusFailed || got.Attempt != 2 {
		t.Fatalf("review stage = %+v, want failed attempt=2", got)
	}
}

// TestUpstreamFindingsThreadedToDownstreamStage drives scan -> verify (dependsOn
// scan) and asserts the engine resolves scan's finding onto verify's StartInput,
// while scan itself (no dependsOn) receives none.
func TestUpstreamFindingsThreadedToDownstreamStage(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("verify-loop", 1, agentStage("scan"), agentStage("verify", "scan"))
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	// scan gets no upstream (no dependsOn).
	if up := fake.upstreamInput("scan").UpstreamFindings; len(up) != 0 {
		t.Fatalf("scan should have no upstream findings, got %d", len(up))
	}

	// Complete scan with a finding; the tick starts verify with that finding
	// resolved onto its input.
	fake.complete("scan", pipeline.VerdictPass, finding("bug"))
	e.Tick()

	if fake.startCount("verify") != 1 {
		t.Fatalf("verify started %d times, want 1", fake.startCount("verify"))
	}
	up := fake.upstreamInput("verify").UpstreamFindings
	if len(up) != 1 {
		t.Fatalf("verify upstream findings = %d, want 1", len(up))
	}
	if up[0].StageName != "scan" || up[0].Title != "bug" || up[0].Fingerprint == "" {
		t.Fatalf("verify upstream finding = %+v, want scan's fingerprinted bug", up[0])
	}
	_ = runID
}

// TestStatusRecordFlipsFindingStatus drives scan -> verify where verify emits a
// {kind:"status"} record dismissing scan's finding, then asserts the finding's
// status flips both in engine state and in the persisted store.
func TestStatusRecordFlipsFindingStatus(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("verify-loop", 1, agentStage("scan"), agentStage("verify", "scan"))
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	fake.complete("scan", pipeline.VerdictPass, finding("bug"))
	e.Tick() // scan completes, verify starts

	fp := e.State().Runs[runID].Findings[0].Fingerprint
	artifactID := e.State().Runs[runID].Findings[0].ArtifactID
	if fp == "" {
		t.Fatal("scan finding has no fingerprint")
	}

	// verify dismisses scan's finding by fingerprint.
	fake.completeStatus("verify", pipeline.FindingStatusChange{Fingerprint: fp, Status: pipeline.ArtifactStatusDismissed})
	e.Tick() // verify completes, status change applied, run terminates

	run := e.State().Runs[runID]
	if run.Findings[0].Status != pipeline.ArtifactStatusDismissed {
		t.Fatalf("in-memory finding status = %s, want dismissed", run.Findings[0].Status)
	}

	art, ok, err := store.GetPipelineArtifact(ctx, artifactID)
	if err != nil || !ok {
		t.Fatalf("get persisted artifact: ok=%v err=%v", ok, err)
	}
	if art.Status != pipeline.ArtifactStatusDismissed {
		t.Fatalf("persisted artifact status = %s, want dismissed", art.Status)
	}
}

// TestStatusRecordUnknownFingerprintTolerated asserts a status record naming a
// fingerprint that matches no finding emits an observation and does NOT fail the
// stage or run.
func TestStatusRecordUnknownFingerprintTolerated(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	sink := &captureSink{}
	e := newTestEngine(t, "mer", store, fake, sink)

	p := pipelineOf("verify-loop", 1, agentStage("scan"), agentStage("verify", "scan"))
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	fake.complete("scan", pipeline.VerdictPass, finding("bug"))
	e.Tick()

	fake.completeStatus("verify", pipeline.FindingStatusChange{Fingerprint: "does-not-exist", Status: pipeline.ArtifactStatusResolved})
	e.Tick()

	if n := sink.count("pipeline.status.unknown_fingerprint"); n != 1 {
		t.Fatalf("unknown_fingerprint observation count = %d, want 1", n)
	}
	run := e.State().Runs[runID]
	if run.Stages["verify"].Status != pipeline.StageStatusSucceeded {
		t.Fatalf("verify stage = %s, want succeeded (unknown fp must not fail it)", run.Stages["verify"].Status)
	}
	// scan's finding stays open (nothing matched).
	if run.Findings[0].Status != pipeline.ArtifactStatusOpen {
		t.Fatalf("finding status = %s, want open (untouched)", run.Findings[0].Status)
	}
}

// TestLastStageResolveMakesDoneFire proves the exit decision sees post-flip
// finding statuses: a verify stage resolving the only open finding must make a
// no_open_findings `done` predicate fire (LoopDone), not stall. This only holds
// because status records are applied in the reducer BEFORE decideRunExit.
func TestLastStageResolveMakesDoneFire(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("verify-loop", 1, agentStage("scan"), agentStage("verify", "scan"))
	p.ExitPredicates = &pipeline.ExitPredicates{Done: &pipeline.Predicate{Kind: pipeline.PredicateNoOpenFindings}}
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	fake.complete("scan", pipeline.VerdictPass, finding("bug"))
	e.Tick() // scan done (finding open), verify starts

	fp := e.State().Runs[runID].Findings[0].Fingerprint
	fake.completeStatus("verify", pipeline.FindingStatusChange{Fingerprint: fp, Status: pipeline.ArtifactStatusResolved})
	e.Tick() // verify done; resolve applied before the exit decision

	run := e.State().Runs[runID]
	if run.LoopState != pipeline.LoopDone {
		t.Fatalf("loop state = %s/%s, want done (resolved finding must satisfy no_open_findings)", run.LoopState, run.TerminationReason)
	}
	if run.Findings[0].Status != pipeline.ArtifactStatusResolved {
		t.Fatalf("finding status = %s, want resolved", run.Findings[0].Status)
	}
}

// TestLastStageReopenPreventsDone is the mirror: a finding resolved by an earlier
// stage but reopened by the last stage must leave a no_open_findings `done`
// predicate unmet, so the run stalls instead of reporting done.
func TestLastStageReopenPreventsDone(t *testing.T) {
	store := newTestStore(t, "mer")
	fake := newFakeExecutor()
	e := newTestEngine(t, "mer", store, fake, nil)

	p := pipelineOf("verify-loop", 1,
		agentStage("scan"),
		agentStage("triage", "scan"),
		agentStage("verify", "triage"))
	p.ExitPredicates = &pipeline.ExitPredicates{Done: &pipeline.Predicate{Kind: pipeline.PredicateNoOpenFindings}}
	runID, err := e.TriggerRun(TriggerRequest{Pipeline: p, SessionID: "mer-1", HeadSHA: "sha1"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}

	fake.complete("scan", pipeline.VerdictPass, finding("bug"))
	e.Tick() // scan done, triage starts
	fp := e.State().Runs[runID].Findings[0].Fingerprint

	fake.completeStatus("triage", pipeline.FindingStatusChange{Fingerprint: fp, Status: pipeline.ArtifactStatusResolved})
	e.Tick() // triage done (finding resolved), verify starts

	fake.completeStatus("verify", pipeline.FindingStatusChange{Fingerprint: fp, Status: pipeline.ArtifactStatusOpen})
	e.Tick() // verify done; reopen applied before the exit decision

	run := e.State().Runs[runID]
	if run.LoopState != pipeline.LoopStalled || run.TerminationReason != pipeline.TerminationDonePredicateUnmet {
		t.Fatalf("loop state = %s/%s, want stalled/done_predicate_unmet (reopened finding blocks done)", run.LoopState, run.TerminationReason)
	}
	if run.Findings[0].Status != pipeline.ArtifactStatusOpen {
		t.Fatalf("finding status = %s, want open (reopened)", run.Findings[0].Status)
	}
}
