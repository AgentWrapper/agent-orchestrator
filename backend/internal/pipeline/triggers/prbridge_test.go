package triggers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// ---------------------------------------------------------------------------
// Fakes shared by prbridge_test.go and sessionbridge_test.go
// ---------------------------------------------------------------------------

type fakeDefs struct {
	byProject map[domain.ProjectID][]pipeline.Definition
	err       error
}

func (f *fakeDefs) ListPipelineDefinitions(_ context.Context, projectID domain.ProjectID) ([]pipeline.Definition, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.byProject[projectID], nil
}

// fakeEngine records the trigger requests it was handed, in order.
type fakeEngine struct {
	mu       sync.Mutex
	requests []TriggerRequest
	nextID   int
}

func (f *fakeEngine) TriggerRun(req TriggerRequest) (pipeline.RunID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, req)
	f.nextID++
	return pipeline.RunID(fmt.Sprintf("run-%d", f.nextID)), nil
}

func (f *fakeEngine) all() []TriggerRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]TriggerRequest(nil), f.requests...)
}

// count is how many runs were triggered for one event name, across definitions.
func (f *fakeEngine) count(event string) int {
	n := 0
	for _, r := range f.all() {
		if r.Event == event {
			n++
		}
	}
	return n
}

// countFor is how many runs were triggered for one event name on one pipeline.
func (f *fakeEngine) countFor(pipelineName, event string) int {
	n := 0
	for _, r := range f.all() {
		if r.Event == event && r.Definition.Name == pipelineName {
			n++
		}
	}
	return n
}

type fakeProvider struct{ eng Engine }

func (p fakeProvider) For(context.Context, domain.ProjectID) (Engine, error) { return p.eng, nil }

type fakePRs struct {
	facts map[string]domain.PRFacts
	rows  map[string]domain.PullRequest
}

func (f *fakePRs) GetPRFactsByURL(_ context.Context, url string) (domain.PRFacts, bool, error) {
	fct, ok := f.facts[url]
	return fct, ok, nil
}

func (f *fakePRs) GetPR(_ context.Context, url string) (domain.PullRequest, bool, error) {
	row, ok := f.rows[url]
	return row, ok, nil
}

// logSink captures what a bridge logged so the drop-and-log contract is
// assertable.
func logSink() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})), &buf
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const (
	testProject = "proj-1"
	testSession = "sess-1"
	testURL     = "https://github.com/o/r/pull/1"
	testRepo    = "o/r"
)

// prDefOn builds a definition subscribing to exactly the given PR events.
func prDefOn(name string, events ...pipeline.PREvent) pipeline.Definition {
	return pipeline.Definition{
		ID:        pipeline.ID("def-" + name),
		ProjectID: testProject,
		Name:      name,
		Config: pipeline.Pipeline{
			Name:   name,
			On:     pipeline.TriggerSpec{PR: events},
			Stages: []pipeline.Stage{{ID: "review", Executor: pipeline.ExecutorAgent, Agent: "claude-code", Prompt: "look"}},
		},
	}
}

// sessionDefOn builds a definition subscribing to exactly the given session
// events. It lives here with the other fixtures because both bridge tests use
// the same fakes.
func sessionDefOn(name string, events ...pipeline.SessionEvent) pipeline.Definition {
	def := prDefOn(name)
	def.Config.On = pipeline.TriggerSpec{Session: events}
	return def
}

func readyFacts(sha string) domain.PRFacts {
	fork := false
	return domain.PRFacts{
		URL: testURL, Number: 1, CI: domain.CIPassing, Review: domain.ReviewApproved,
		Mergeability: domain.MergeMergeable, HeadSHA: sha, IsFromFork: &fork,
	}
}

// notReadyFacts is not merge-ready: failing CI blocks it.
func notReadyFacts(sha string) domain.PRFacts {
	f := readyFacts(sha)
	f.CI = domain.CIFailing
	return f
}

func mergedFacts(sha string) domain.PRFacts {
	f := readyFacts(sha)
	f.Merged = true
	f.Mergeability = domain.MergeUnknown
	return f
}

func prRow(sha string) domain.PullRequest {
	return domain.PullRequest{
		URL: testURL, SessionID: testSession, Number: 1, Repo: testRepo,
		SourceBranch: "feature", TargetBranch: "main", HeadSHA: sha,
	}
}

func prEvent(t cdc.EventType) cdc.Event {
	payload, _ := json.Marshal(prPayload{URL: testURL, Session: testSession})
	return cdc.Event{Seq: 1, ProjectID: testProject, SessionID: testSession, Type: t, Payload: payload}
}

// newPRBridge wires a PRBridge over fakes. The returned maps are the live
// fixtures, so a test can mutate the PR between events.
func newPRBridge(defs []pipeline.Definition, facts map[string]domain.PRFacts, rows map[string]domain.PullRequest) (*PRBridge, *fakeEngine) {
	eng := &fakeEngine{}
	log, _ := logSink()
	b := NewPRBridge(PRConfig{
		Broadcaster: cdc.NewBroadcaster(),
		Defs:        &fakeDefs{byProject: map[domain.ProjectID][]pipeline.Definition{testProject: defs}},
		PRs:         &fakePRs{facts: facts, rows: rows},
		Engines:     fakeProvider{eng: eng},
		Logger:      log,
	})
	return b, eng
}

// newReadyPRBridge is newPRBridge with a single merge-ready PR at sha1.
func newReadyPRBridge(defs ...pipeline.Definition) (*PRBridge, *fakeEngine) {
	return newPRBridge(defs,
		map[string]domain.PRFacts{testURL: readyFacts("sha1")},
		map[string]domain.PullRequest{testURL: prRow("sha1")})
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

func TestPRCreatedFiresCreated(t *testing.T) {
	b, eng := newReadyPRBridge(prDefOn("opener", pipeline.PREventCreated))

	b.process(context.Background(), prEvent(cdc.EventPRCreated))

	if got := eng.count(string(pipeline.PREventCreated)); got != 1 {
		t.Fatalf("created triggers = %d, want 1", got)
	}
}

func TestPRUpdatedFiresUpdated(t *testing.T) {
	b, eng := newReadyPRBridge(prDefOn("watcher", pipeline.PREventUpdated))

	b.process(context.Background(), prEvent(cdc.EventPRUpdated))

	if got := eng.count(string(pipeline.PREventUpdated)); got != 1 {
		t.Fatalf("updated triggers = %d, want 1", got)
	}
	if got := eng.count(string(pipeline.PREventCreated)); got != 0 {
		t.Fatalf("created triggers = %d, want 0 on a pr_updated event", got)
	}
}

func TestPRCreatedDoesNotFireUpdated(t *testing.T) {
	b, eng := newReadyPRBridge(prDefOn("watcher", pipeline.PREventUpdated))

	b.process(context.Background(), prEvent(cdc.EventPRCreated))

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0 (created is not updated)", got)
	}
}

func TestNonSubscribingDefinitionDoesNotFire(t *testing.T) {
	// A session-only pipeline must ignore PR events entirely.
	b, eng := newReadyPRBridge(sessionDefOn("sessionOnly", pipeline.SessionEventIdle))

	b.process(context.Background(), prEvent(cdc.EventPRCreated))
	b.process(context.Background(), prEvent(cdc.EventPRUpdated))

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0 for a definition with no pr events", got)
	}
}

func TestTriggerCarriesPRSubject(t *testing.T) {
	def := prDefOn("opener", pipeline.PREventCreated)
	b, eng := newReadyPRBridge(def)

	b.process(context.Background(), prEvent(cdc.EventPRCreated))

	reqs := eng.all()
	if len(reqs) != 1 {
		t.Fatalf("triggers = %d, want 1", len(reqs))
	}
	req := reqs[0]
	if req.Definition.ID != def.ID {
		t.Fatalf("definition id = %q, want %q", req.Definition.ID, def.ID)
	}
	s := req.Subject
	if s.Kind != pipeline.SubjectPR || s.ProjectID != testProject || s.SessionID != testSession {
		t.Fatalf("subject envelope = %+v", s)
	}
	if s.PR == nil {
		t.Fatalf("subject has no PR ref: %+v", s)
	}
	want := pipeline.PRRef{
		Number: 1, Repo: testRepo, URL: testURL, HeadSHA: "sha1",
		HeadBranch: "feature", BaseBranch: "main", FromFork: false,
	}
	if *s.PR != want {
		t.Fatalf("pr ref = %+v, want %+v", *s.PR, want)
	}
}

func TestSessionlessPRStillTriggers(t *testing.T) {
	// Sessionless is first-class (spec section 4): a pipeline watching someone
	// else's PR must run with no session anywhere in the picture.
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	row := prRow("sha1")
	row.SessionID = ""
	b, eng := newPRBridge([]pipeline.Definition{prDefOn("opener", pipeline.PREventCreated)},
		facts, map[string]domain.PullRequest{testURL: row})

	ev := prEvent(cdc.EventPRCreated)
	ev.SessionID = ""
	ev.Payload, _ = json.Marshal(prPayload{URL: testURL})

	b.process(context.Background(), ev)

	reqs := eng.all()
	if len(reqs) != 1 {
		t.Fatalf("triggers = %d, want 1 for a sessionless PR", len(reqs))
	}
	if reqs[0].Subject.SessionID != "" {
		t.Fatalf("subject session = %q, want empty", reqs[0].Subject.SessionID)
	}
}

func TestForkProvenanceUnknownTreatedAsFork(t *testing.T) {
	// nil IsFromFork means unknown, and the identity-only rule fails safe:
	// unknown provenance is treated as a fork so no credential is injected.
	facts := readyFacts("sha1")
	facts.IsFromFork = nil
	b, eng := newPRBridge([]pipeline.Definition{prDefOn("opener", pipeline.PREventCreated)},
		map[string]domain.PRFacts{testURL: facts},
		map[string]domain.PullRequest{testURL: prRow("sha1")})

	b.process(context.Background(), prEvent(cdc.EventPRCreated))

	reqs := eng.all()
	if len(reqs) != 1 {
		t.Fatalf("triggers = %d, want 1", len(reqs))
	}
	if !reqs[0].Subject.PR.FromFork {
		t.Fatalf("FromFork = false for unknown provenance, want true (fail-safe)")
	}
}

// ---------------------------------------------------------------------------
// Transition detection
// ---------------------------------------------------------------------------

func TestMergeReadyFiresOnceOnTransition(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: notReadyFacts("sha1")}
	b, eng := newPRBridge([]pipeline.Definition{prDefOn("gate", pipeline.PREventMergeReady)},
		facts, map[string]domain.PullRequest{testURL: prRow("sha1")})

	// Not ready yet.
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	if got := eng.count(string(pipeline.PREventMergeReady)); got != 0 {
		t.Fatalf("merge-ready before the transition = %d, want 0", got)
	}

	// Transition into ready fires once, and holding there fires nothing more.
	facts[testURL] = readyFacts("sha1")
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	b.process(ctx, prEvent(cdc.EventPRUpdated))

	if got := eng.count(string(pipeline.PREventMergeReady)); got != 1 {
		t.Fatalf("merge-ready across the hold = %d, want exactly 1", got)
	}
}

func TestMergeReadyFirstSeenAlreadyReadyFires(t *testing.T) {
	// A PR first seen already merge-ready counts as a transition, so a pipeline
	// armed after the fact still runs.
	b, eng := newReadyPRBridge(prDefOn("gate", pipeline.PREventMergeReady))

	b.process(context.Background(), prEvent(cdc.EventPRUpdated))

	if got := eng.count(string(pipeline.PREventMergeReady)); got != 1 {
		t.Fatalf("first-seen merge-ready = %d, want 1", got)
	}
}

func TestMergeReadyRefiresAfterLeavingTheState(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	b, eng := newPRBridge([]pipeline.Definition{prDefOn("gate", pipeline.PREventMergeReady)},
		facts, map[string]domain.PullRequest{testURL: prRow("sha1")})

	b.process(ctx, prEvent(cdc.EventPRUpdated))
	facts[testURL] = notReadyFacts("sha1")
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	facts[testURL] = readyFacts("sha1")
	b.process(ctx, prEvent(cdc.EventPRUpdated))

	if got := eng.count(string(pipeline.PREventMergeReady)); got != 2 {
		t.Fatalf("merge-ready across a leave-and-return = %d, want 2", got)
	}
}

func TestMergedFiresOnceOnTransition(t *testing.T) {
	ctx := context.Background()
	facts := map[string]domain.PRFacts{testURL: readyFacts("sha1")}
	b, eng := newPRBridge([]pipeline.Definition{prDefOn("onMerge", pipeline.PREventMerged)},
		facts, map[string]domain.PullRequest{testURL: prRow("sha1")})

	b.process(ctx, prEvent(cdc.EventPRUpdated))
	if got := eng.count(string(pipeline.PREventMerged)); got != 0 {
		t.Fatalf("merged while open = %d, want 0", got)
	}

	facts[testURL] = mergedFacts("sha1")
	b.process(ctx, prEvent(cdc.EventPRUpdated))
	b.process(ctx, prEvent(cdc.EventPRUpdated))

	if got := eng.count(string(pipeline.PREventMerged)); got != 1 {
		t.Fatalf("merged across the hold = %d, want exactly 1", got)
	}
}

func TestTransitionsAreTrackedPerPR(t *testing.T) {
	// A stacked-PR session tracks each PR independently: the second PR's first
	// sighting is its own transition.
	ctx := context.Background()
	const otherURL = "https://github.com/o/r/pull/2"
	other := readyFacts("sha2")
	other.URL = otherURL
	other.Number = 2
	otherRow := prRow("sha2")
	otherRow.URL = otherURL
	otherRow.Number = 2

	b, eng := newPRBridge([]pipeline.Definition{prDefOn("gate", pipeline.PREventMergeReady)},
		map[string]domain.PRFacts{testURL: readyFacts("sha1"), otherURL: other},
		map[string]domain.PullRequest{testURL: prRow("sha1"), otherURL: otherRow})

	b.process(ctx, prEvent(cdc.EventPRUpdated))
	ev := prEvent(cdc.EventPRUpdated)
	ev.Payload, _ = json.Marshal(prPayload{URL: otherURL, Session: testSession})
	b.process(ctx, ev)

	if got := eng.count(string(pipeline.PREventMergeReady)); got != 2 {
		t.Fatalf("merge-ready across two PRs = %d, want 2", got)
	}
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

func TestFanOutAcrossDefinitions(t *testing.T) {
	b, eng := newReadyPRBridge(
		prDefOn("a", pipeline.PREventUpdated),
		prDefOn("b", pipeline.PREventUpdated, pipeline.PREventMergeReady),
		prDefOn("c", pipeline.PREventMerged),
	)

	b.process(context.Background(), prEvent(cdc.EventPRUpdated))

	if got := eng.countFor("a", string(pipeline.PREventUpdated)); got != 1 {
		t.Fatalf("a updated = %d, want 1", got)
	}
	if got := eng.countFor("b", string(pipeline.PREventUpdated)); got != 1 {
		t.Fatalf("b updated = %d, want 1", got)
	}
	if got := eng.countFor("b", string(pipeline.PREventMergeReady)); got != 1 {
		t.Fatalf("b merge-ready = %d, want 1", got)
	}
	if got := eng.countFor("c", string(pipeline.PREventMerged)); got != 0 {
		t.Fatalf("c merged = %d, want 0 (the PR is not merged)", got)
	}
	if got := len(eng.all()); got != 3 {
		t.Fatalf("total triggers = %d, want 3", got)
	}
}

// ---------------------------------------------------------------------------
// Queue discipline
// ---------------------------------------------------------------------------

func TestPREnqueueIgnoresOtherEventTypes(t *testing.T) {
	b, _ := newReadyPRBridge(prDefOn("opener", pipeline.PREventCreated))

	b.enqueue(cdc.Event{Type: cdc.EventSessionUpdated, ProjectID: testProject})
	b.enqueue(cdc.Event{Type: cdc.EventPipelineRunUpdated, ProjectID: testProject})

	if got := len(b.queue); got != 0 {
		t.Fatalf("queued = %d, want 0 for non-PR events", got)
	}
}

func TestPREnqueueDropsWhenQueueFull(t *testing.T) {
	eng := &fakeEngine{}
	log, buf := logSink()
	b := NewPRBridge(PRConfig{
		Broadcaster: cdc.NewBroadcaster(),
		Defs:        &fakeDefs{},
		PRs:         &fakePRs{},
		Engines:     fakeProvider{eng: eng},
		Logger:      log,
	})

	// No worker is running, so the buffer fills and the overflow is dropped
	// rather than blocking the CDC poller goroutine.
	for i := 0; i < queueCap+5; i++ {
		b.enqueue(prEvent(cdc.EventPRUpdated))
	}

	if got := len(b.queue); got != queueCap {
		t.Fatalf("queued = %d, want %d (buffer cap)", got, queueCap)
	}
	if !strings.Contains(buf.String(), "dropping") {
		t.Fatalf("overflow was not logged: %s", buf.String())
	}
}

func TestPRBridgeDeliversThroughBroadcaster(t *testing.T) {
	bcast := cdc.NewBroadcaster()
	eng := &fakeEngine{}
	b := NewPRBridge(PRConfig{
		Broadcaster: bcast,
		Defs:        &fakeDefs{byProject: map[domain.ProjectID][]pipeline.Definition{testProject: {prDefOn("opener", pipeline.PREventCreated)}}},
		PRs: &fakePRs{
			facts: map[string]domain.PRFacts{testURL: readyFacts("sha1")},
			rows:  map[string]domain.PullRequest{testURL: prRow("sha1")},
		},
		Engines: fakeProvider{eng: eng},
	})
	b.Start(context.Background())
	t.Cleanup(b.Stop)

	bcast.Publish(prEvent(cdc.EventPRCreated))

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if eng.count(string(pipeline.PREventCreated)) == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("created trigger not observed within the deadline (async delivery failed)")
}

func TestPRProcessIgnoresIncompleteEvents(t *testing.T) {
	ctx := context.Background()
	b, eng := newReadyPRBridge(prDefOn("opener", pipeline.PREventCreated))

	noProject := prEvent(cdc.EventPRCreated)
	noProject.ProjectID = ""
	b.process(ctx, noProject)

	noURL := prEvent(cdc.EventPRCreated)
	noURL.Payload, _ = json.Marshal(prPayload{Session: testSession})
	b.process(ctx, noURL)

	badPayload := prEvent(cdc.EventPRCreated)
	badPayload.Payload = []byte("not json")
	b.process(ctx, badPayload)

	unknownPR := prEvent(cdc.EventPRCreated)
	unknownPR.Payload, _ = json.Marshal(prPayload{URL: "https://github.com/o/r/pull/99", Session: testSession})
	b.process(ctx, unknownPR)

	if got := len(eng.all()); got != 0 {
		t.Fatalf("triggers = %d, want 0 for incomplete events", got)
	}
}

func TestPRStopWithoutStartIsSafe(t *testing.T) {
	b, _ := newReadyPRBridge(prDefOn("opener", pipeline.PREventCreated))
	b.Stop()
}
