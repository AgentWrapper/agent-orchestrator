package triggers

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/engine"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type fakePRs struct {
	facts map[string]domain.PRFacts
}

func (f *fakePRs) GetPRFactsByURL(_ context.Context, url string) (domain.PRFacts, bool, error) {
	fct, ok := f.facts[url]
	return fct, ok, nil
}

type fakeDefs struct {
	byProject map[domain.ProjectID][]pipeline.Definition
}

func (f *fakeDefs) ListPipelineDefinitions(_ context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error) {
	return f.byProject[projectID], nil
}

// fakeEngine records the trigger/dispatch calls in order so tests can assert
// both the set and the sequencing (NEW_SHA_DETECTED before the rearm trigger).
type fakeEngine struct {
	mu       sync.Mutex
	triggers []engine.TriggerRequest
	dispatch []pipeline.Event
	ops      []string
	nextID   int
}

func (f *fakeEngine) TriggerRun(req engine.TriggerRequest) (pipeline.RunID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.triggers = append(f.triggers, req)
	f.ops = append(f.ops, fmt.Sprintf("trigger:%s:%s", req.Trigger, req.HeadSHA))
	f.nextID++
	return pipeline.RunID(fmt.Sprintf("run-%d", f.nextID)), nil
}

func (f *fakeEngine) Dispatch(e pipeline.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dispatch = append(f.dispatch, e)
	sha := ""
	if n, ok := e.(pipeline.NewSHADetected); ok {
		sha = n.SHA
	}
	f.ops = append(f.ops, fmt.Sprintf("dispatch:%s:%s", e.Type(), sha))
}

func (f *fakeEngine) triggerCount(ev pipeline.StageTriggerEvent) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, t := range f.triggers {
		if t.Trigger == ev {
			n++
		}
	}
	return n
}

type fakeProvider struct{ eng Engine }

func (p fakeProvider) For(_ context.Context, _ domain.ProjectID) (Engine, error) {
	return p.eng, nil
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const (
	testProject = "proj-1"
	testSession = "sess-1"
	testURL     = "https://github.com/o/r/pull/1"
)

// defOn builds a definition whose single stage subscribes to exactly the given
// trigger events.
func defOn(name string, events ...pipeline.StageTriggerEvent) pipeline.Definition {
	stage := pipeline.Stage{
		Name:     "review",
		Trigger:  pipeline.StageTrigger{On: events},
		Executor: pipeline.StageExecutor{Kind: pipeline.ExecutorAgent, Plugin: "claude-code", Mode: pipeline.ModeReview},
	}
	return pipeline.Definition{
		ID:        pipeline.ID("def-" + name),
		ProjectID: testProject,
		Name:      name,
		Config:    pipeline.Pipeline{Name: name, Scope: pipeline.ScopeWorker, Stages: []pipeline.Stage{stage}},
	}
}

func readyFacts(sha string) domain.PRFacts {
	return domain.PRFacts{URL: testURL, Number: 1, CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable, HeadSHA: sha}
}

func notReadyFacts(sha string) domain.PRFacts {
	// CI failing blocks merge-readiness.
	return domain.PRFacts{URL: testURL, Number: 1, CI: domain.CIFailing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable, HeadSHA: sha}
}

func mergedFacts(sha string) domain.PRFacts {
	return domain.PRFacts{URL: testURL, Number: 1, Merged: true, CI: domain.CIPassing, Review: domain.ReviewApproved, HeadSHA: sha}
}

func prEvent(t cdc.EventType) cdc.Event {
	payload, _ := json.Marshal(prPayload{URL: testURL, Session: testSession})
	return cdc.Event{ProjectID: testProject, SessionID: testSession, Type: t, Payload: payload}
}

// newBridge wires a Bridge over fakes with a fixed clock. The facts pointer lets
// a test mutate the PR snapshot between events.
func newBridge(defs []pipeline.Definition, facts map[string]domain.PRFacts) (*Bridge, *fakeEngine) {
	eng := &fakeEngine{}
	b := New(Config{
		Broadcaster: cdc.NewBroadcaster(),
		Defs:        &fakeDefs{byProject: map[domain.ProjectID][]pipeline.Definition{testProject: defs}},
		PRs:         &fakePRs{facts: facts},
		Engines:     fakeProvider{eng: eng},
		Clock:       func() time.Time { return time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC) },
	})
	return b, eng
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestPROpenedTriggersMatchingDefinition(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	b, eng := newBridge([]pipeline.Definition{defOn("opener", pipeline.TriggerPROpened)}, facts)

	b.process(ctx, prEvent(cdc.EventPRCreated))

	if got := eng.triggerCount(pipeline.TriggerPROpened); got != 1 {
		t.Fatalf("pr.opened triggers = %d, want 1", got)
	}
	if req := eng.triggers[0]; req.SessionID != testSession || req.HeadSHA != "sha1" {
		t.Fatalf("trigger req = %+v, want session=%s sha=sha1", req, testSession)
	}
}

func TestTriggerForwardsPRContext(t *testing.T) {
	ctx := context.Background()
	fork := true
	facts := domain.PRFacts{
		URL: testURL, Number: 7, CI: domain.CIPassing, Review: domain.ReviewApproved,
		Mergeability: domain.MergeMergeable, HeadSHA: "sha1",
		SourceBranch: "feature", TargetBranch: "main", IsFromFork: &fork,
	}
	b, eng := newBridge([]pipeline.Definition{defOn("opener", pipeline.TriggerPROpened)}, map[string]domain.PRFacts{testURL: facts})

	b.process(ctx, prEvent(cdc.EventPRCreated))

	if len(eng.triggers) != 1 {
		t.Fatalf("triggers = %d, want 1", len(eng.triggers))
	}
	c := eng.triggers[0].Context
	if c.PRNumber != 7 || c.PRURL != testURL || c.SourceBranch != "feature" ||
		c.TargetBranch != "main" || c.HeadSHA != "sha1" || c.SessionID != testSession {
		t.Fatalf("forwarded PR context = %+v", c)
	}
	if c.IsFromFork == nil || !*c.IsFromFork {
		t.Fatalf("fork tri-state not forwarded: %+v", c.IsFromFork)
	}
}

func TestNonMatchingDefinitionDoesNotTrigger(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	// Subscribes to manual only: a pr.opened event must not start it.
	b, eng := newBridge([]pipeline.Definition{defOn("manualOnly", pipeline.TriggerManual)}, facts)

	b.process(ctx, prEvent(cdc.EventPRCreated))

	if got := len(eng.triggers); got != 0 {
		t.Fatalf("triggers = %d, want 0 for a non-subscribing definition", got)
	}
}

func TestMergeReadyFiresOnceOnTransition(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: notReadyFacts("sha1")}
	b, eng := newBridge([]pipeline.Definition{defOn("gate", pipeline.TriggerPRMergeReady)}, facts)

	// Not ready yet -> no merge_ready trigger.
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	if got := eng.triggerCount(pipeline.TriggerPRMergeReady); got != 0 {
		t.Fatalf("merge_ready before transition = %d, want 0", got)
	}

	// Transition into ready -> fires once.
	facts[testURL] = readyFacts("sha1")
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	// Still ready on the next event -> must NOT fire again.
	b.process(ctx, prEvent(cdc.EventPRUpdated))

	if got := eng.triggerCount(pipeline.TriggerPRMergeReady); got != 1 {
		t.Fatalf("merge_ready across hold = %d, want exactly 1 (fire on transition only)", got)
	}
}

func TestMergeReadyFirstSeenAlreadyReadyFires(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	b, eng := newBridge([]pipeline.Definition{defOn("gate", pipeline.TriggerPRMergeReady)}, facts)

	// First event we ever see for this PR is already merge-ready: counts as a
	// transition and fires.
	b.process(ctx, prEvent(cdc.EventPRUpdated))

	if got := eng.triggerCount(pipeline.TriggerPRMergeReady); got != 1 {
		t.Fatalf("first-seen-ready merge_ready = %d, want 1", got)
	}
}

func TestMergedTransitionFires(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	b, eng := newBridge([]pipeline.Definition{defOn("onMerge", pipeline.TriggerPRMerged)}, facts)

	// Open PR: no merged trigger.
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	if got := eng.triggerCount(pipeline.TriggerPRMerged); got != 0 {
		t.Fatalf("merged before merge = %d, want 0", got)
	}

	// Now merged.
	facts[testURL] = mergedFacts("sha1")
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	if got := eng.triggerCount(pipeline.TriggerPRMerged); got != 1 {
		t.Fatalf("merged after transition = %d, want 1", got)
	}
}

func TestNewSHACancelsAndRearms(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("shaA")}
	b, eng := newBridge([]pipeline.Definition{defOn("loop", pipeline.TriggerPRUpdated)}, facts)

	// First update at shaA: arms a run, no NEW_SHA (nothing prior).
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	if len(eng.dispatch) != 0 {
		t.Fatalf("dispatch after first update = %d, want 0", len(eng.dispatch))
	}

	// New head SHA: cancel-and-rearm.
	facts[testURL] = readyFacts("shaB")
	b.process(ctx, prEvent(cdc.EventPRUpdated))

	if len(eng.dispatch) != 1 {
		t.Fatalf("dispatch after new sha = %d, want 1", len(eng.dispatch))
	}
	ns, ok := eng.dispatch[0].(pipeline.NewSHADetected)
	if !ok || ns.SHA != "shaB" || ns.SessionID != testSession || ns.PipelineName != "loop" {
		t.Fatalf("dispatched event = %+v, want NewSHADetected sha=shaB session=%s pipeline=loop", eng.dispatch[0], testSession)
	}
	if got := eng.triggerCount(pipeline.TriggerPRUpdated); got != 2 {
		t.Fatalf("pr.updated triggers = %d, want 2", got)
	}
	// The rearm trigger must carry the new SHA...
	if last := eng.triggers[len(eng.triggers)-1]; last.HeadSHA != "shaB" {
		t.Fatalf("rearm trigger sha = %s, want shaB", last.HeadSHA)
	}
	// ...and NEW_SHA_DETECTED must be dispatched BEFORE the rearm trigger.
	wantOrder := []string{"trigger:pr.updated:shaA", "dispatch:NEW_SHA_DETECTED:shaB", "trigger:pr.updated:shaB"}
	if fmt.Sprint(eng.ops) != fmt.Sprint(wantOrder) {
		t.Fatalf("op order = %v, want %v", eng.ops, wantOrder)
	}
}

// ---------------------------------------------------------------------------
// Integration: real engine (Supervisor) + real store + mocked executor
// ---------------------------------------------------------------------------

// recExec is a mock StageExecutor that records Start calls and never completes,
// so the integration test can assert a run started without racing the tick.
type recExec struct {
	mu      sync.Mutex
	started int
}

func (e *recExec) Start(_ context.Context, in executors.StartInput) (executors.Handle, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.started++
	return recHandle{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}, nil
}

func (e *recExec) Poll(context.Context, executors.Handle) (executors.Outcome, error) {
	return executors.Outcome{Status: executors.OutcomeRunning}, nil
}
func (e *recExec) Cancel(context.Context, executors.Handle) error { return nil }

func (e *recExec) startCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.started
}

type recHandle struct {
	runID      pipeline.RunID
	stageRunID pipeline.StageRunID
	stageName  string
}

func (h recHandle) RunID() pipeline.RunID           { return h.runID }
func (h recHandle) StageRunID() pipeline.StageRunID { return h.stageRunID }
func (h recHandle) StageName() string               { return h.stageName }

type supEngines struct{ sup *engine.Supervisor }

func (s supEngines) For(ctx context.Context, projectID domain.ProjectID) (Engine, error) {
	return s.sup.For(ctx, projectID)
}

func TestPRCreatedStartsRunThroughRealEngine(t *testing.T) {
	ctx := context.Background()

	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: testProject, Path: "/tmp/" + testProject, RegisteredAt: time.Now().UTC().Truncate(time.Second)}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	// A real definition in the store, subscribing to pr.opened.
	def := defOn("review", pipeline.TriggerPROpened)
	def.CreatedAt = time.Now().UTC()
	def.UpdatedAt = def.CreatedAt
	if err := store.CreatePipelineDefinition(ctx, def); err != nil {
		t.Fatalf("create definition: %v", err)
	}

	exec := &recExec{}
	sup := engine.NewSupervisor(engine.SupervisorConfig{
		Store:        store,
		Executors:    executors.NewSet(exec, exec, exec),
		Projects:     store,
		TickInterval: time.Hour, // no heartbeat; the run just needs to start
	})
	if err := sup.Start(ctx); err != nil {
		t.Fatalf("supervisor start: %v", err)
	}
	t.Cleanup(func() { _ = sup.Stop(ctx) })

	b := New(Config{
		Broadcaster: cdc.NewBroadcaster(),
		Defs:        store,
		PRs:         &fakePRs{facts: map[string]domain.PRFacts{testURL: readyFacts("sha1")}},
		Engines:     supEngines{sup: sup},
	})

	b.process(ctx, prEvent(cdc.EventPRCreated))

	if exec.startCount() != 1 {
		t.Fatalf("executor Start count = %d, want 1 (run should have started)", exec.startCount())
	}
	eng, err := sup.For(ctx, testProject)
	if err != nil {
		t.Fatalf("engine for project: %v", err)
	}
	runs := eng.State().Runs
	if len(runs) != 1 {
		t.Fatalf("engine runs = %d, want 1", len(runs))
	}
	for _, r := range runs {
		if r.SessionID != testSession || r.PipelineName != "review" || r.HeadSHA != "sha1" {
			t.Fatalf("run = %+v, want session=%s pipeline=review sha=sha1", r, testSession)
		}
	}
}

// TestBridgeAsyncDeliveryThroughBroadcaster covers the Subscribe -> enqueue ->
// worker path: a published CDC event eventually drives a trigger without
// blocking the publisher.
func TestBridgeAsyncDeliveryThroughBroadcaster(t *testing.T) {
	ctx := context.Background()
	bcast := cdc.NewBroadcaster()
	eng := &fakeEngine{}
	b := New(Config{
		Broadcaster: bcast,
		Defs:        &fakeDefs{byProject: map[domain.ProjectID][]pipeline.Definition{testProject: {defOn("opener", pipeline.TriggerPROpened)}}},
		PRs:         &fakePRs{facts: map[string]domain.PRFacts{testURL: readyFacts("sha1")}},
		Engines:     fakeProvider{eng: eng},
	})
	b.Start(ctx)
	t.Cleanup(b.Stop)

	bcast.Publish(prEvent(cdc.EventPRCreated))

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if eng.triggerCount(pipeline.TriggerPROpened) == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("pr.opened trigger not observed within deadline (async delivery failed)")
}
