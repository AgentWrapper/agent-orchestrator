package engine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// fakeHandle is one started stage in the fake executor. The test scripts what
// each poll returns by pushing states onto next.
type fakeHandle struct {
	in    executors.StartInput
	mu    sync.Mutex
	polls []executors.Poll

	interrupted bool
	cancelled   bool
}

func (h *fakeHandle) RunID() pipeline.RunID { return h.in.RunID }
func (h *fakeHandle) StageID() string       { return h.in.Stage.ID }
func (h *fakeHandle) Attempt() int          { return h.in.Attempt }
func (h *fakeHandle) SessionID() string     { return "sess-" + h.in.Stage.ID }

// fakeHandlePGID is the group every fake command stage claims to run in.
const fakeHandlePGID = 7331

// ProcessGroup mirrors the real handles: a command stage runs in a process
// group of its own, an agent stage runs in a session and has none.
func (h *fakeHandle) ProcessGroup() int {
	if h.in.Stage.Executor == pipeline.ExecutorCommand {
		return fakeHandlePGID
	}
	return 0
}

// fakeExecutor records every Start and replays scripted poll results.
type fakeExecutor struct {
	mu      sync.Mutex
	started []*fakeHandle
	failOn  map[string]error
}

func newFakeExecutor() *fakeExecutor {
	return &fakeExecutor{failOn: map[string]error{}}
}

func (x *fakeExecutor) Start(_ context.Context, in executors.StartInput) (executors.Handle, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if err := x.failOn[in.Stage.ID]; err != nil {
		return nil, err
	}
	h := &fakeHandle{in: in}
	x.started = append(x.started, h)
	return h, nil
}

func (x *fakeExecutor) Poll(_ context.Context, h executors.Handle) (executors.Poll, error) {
	fh, ok := h.(*fakeHandle)
	if !ok {
		return executors.Poll{}, errors.New("unexpected handle")
	}
	fh.mu.Lock()
	defer fh.mu.Unlock()
	if len(fh.polls) == 0 {
		return executors.Poll{State: executors.PollRunning}, nil
	}
	out := fh.polls[0]
	fh.polls = fh.polls[1:]
	return out, nil
}

func (x *fakeExecutor) Cancel(_ context.Context, h executors.Handle) error {
	if fh, ok := h.(*fakeHandle); ok {
		fh.cancelled = true
	}
	return nil
}

func (x *fakeExecutor) Interrupt(_ context.Context, h executors.Handle) error {
	if fh, ok := h.(*fakeHandle); ok {
		fh.interrupted = true
	}
	return nil
}

// handle returns the most recent start of a stage.
func (x *fakeExecutor) handle(t *testing.T, stage string) *fakeHandle {
	t.Helper()
	x.mu.Lock()
	defer x.mu.Unlock()
	for i := len(x.started) - 1; i >= 0; i-- {
		if x.started[i].in.Stage.ID == stage {
			return x.started[i]
		}
	}
	t.Fatalf("stage %q was never started (started: %v)", stage, x.startedIDs())
	return nil
}

func (x *fakeExecutor) startedIDs() []string {
	ids := make([]string, 0, len(x.started))
	for _, h := range x.started {
		ids = append(ids, h.in.Stage.ID)
	}
	return ids
}

// script queues poll results for a started stage.
func (x *fakeExecutor) script(t *testing.T, stage string, polls ...executors.Poll) {
	t.Helper()
	h := x.handle(t, stage)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.polls = append(h.polls, polls...)
}

// fakeProvisioner hands every stage a directory under root and records the
// destroy calls the teardown policy makes.
type fakeProvisioner struct {
	root string

	mu        sync.Mutex
	requests  []executors.WorkspaceRequest
	destroyed []string
	failOn    map[string]error
}

func newFakeProvisioner(root string) *fakeProvisioner {
	return &fakeProvisioner{root: root, failOn: map[string]error{}}
}

func (p *fakeProvisioner) Provision(_ context.Context, req executors.WorkspaceRequest) (string, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.requests = append(p.requests, req)
	if err := p.failOn[req.StageID]; err != nil {
		return "", false, err
	}
	if req.Kind == pipeline.WorkspaceInherit {
		return req.InheritPath, false, nil
	}
	path := filepath.Join(p.root, req.StageID)
	owned := req.Kind == pipeline.WorkspaceRun || req.Kind == pipeline.WorkspaceStage
	if req.Kind == pipeline.WorkspaceRun {
		path = filepath.Join(p.root, "run")
	}
	return path, owned, nil
}

func (p *fakeProvisioner) Destroy(_ context.Context, path string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.destroyed = append(p.destroyed, path)
	return nil
}

func (p *fakeProvisioner) destroyedPaths() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.destroyed...)
}

// fakeStore is an in-memory stand-in for the SQLite pipeline store.
type fakeStore struct {
	mu sync.Mutex
	// counters is the per-pipeline run number sequence, keyed the way the real
	// store keys it: by pipeline name.
	counters map[string]int
	runs     map[pipeline.RunID]pipeline.RunState
	hydra    []pipeline.RunState
	saves    int
	saveErr  error
}

func newFakeStore() *fakeStore {
	return &fakeStore{runs: map[pipeline.RunID]pipeline.RunState{}, counters: map[string]int{}}
}

func (s *fakeStore) SavePipelineRun(_ context.Context, run *pipeline.RunState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saves++
	if s.saveErr != nil {
		return s.saveErr
	}
	// Same contract as the SQLite store: the row owns the run number, the
	// insert allocates it, and a re-save keeps whatever the row already had.
	if prev, ok := s.runs[run.RunID]; ok {
		run.RunNumber = prev.RunNumber
	} else {
		s.counters[run.PipelineName]++
		run.RunNumber = s.counters[run.PipelineName]
	}
	s.runs[run.RunID] = *run
	return nil
}

func (s *fakeStore) HydratePipelineEngineState(context.Context, domain.ProjectID) ([]pipeline.RunState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hydra, nil
}

func (s *fakeStore) saved(id pipeline.RunID) (pipeline.RunState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[id]
	return run, ok
}

// fakeMessenger records nudges.
type fakeMessenger struct {
	mu   sync.Mutex
	sent []string
	err  error
}

func (m *fakeMessenger) Alive(context.Context, string) (bool, error) { return true, nil }

func (m *fakeMessenger) Send(_ context.Context, sessionID, message string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	m.sent = append(m.sent, sessionID+": "+message)
	return nil
}

func (m *fakeMessenger) messages() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.sent...)
}

// fakeSessions is a bare session disposer, for the wirings that only need the
// kill seam to exist. The harness uses fakeOrphanSessions instead, which also
// keeps the rows the orphan marker lands on.
type fakeSessions struct {
	mu     sync.Mutex
	killed []string
}

func (s *fakeSessions) Kill(_ context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.killed = append(s.killed, sessionID)
	return nil
}

// fakeReaper records every process group reconciliation asked it about, so a
// test can assert what was reaped without a real process anywhere near it.
// The clause it returns stands in for whatever the OS reaper would have found.
type fakeReaper struct {
	mu     sync.Mutex
	calls  []reapCall
	clause string
	leaked bool
}

type reapCall struct {
	pgid      int
	startedAt time.Time
}

func (r *fakeReaper) Reap(pgid int, startedAt time.Time) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, reapCall{pgid: pgid, startedAt: startedAt})
	return r.clause, r.leaked
}

func (r *fakeReaper) reaped() []reapCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]reapCall(nil), r.calls...)
}

// fakeCredentials serves engine-held credentials from a map.
type fakeCredentials struct {
	values map[string]map[string]string
}

func (c fakeCredentials) Resolve(_ context.Context, _ string, names []string) (map[string]string, error) {
	out := map[string]string{}
	for _, name := range names {
		env, ok := c.values[name]
		if !ok {
			return nil, errors.New("unknown credential " + name)
		}
		for k, v := range env {
			out[k] = v
		}
	}
	return out, nil
}

func (c fakeCredentials) Names(context.Context, string) ([]string, error) {
	names := make([]string, 0, len(c.values))
	for name := range c.values {
		names = append(names, name)
	}
	return names, nil
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type harness struct {
	engine *Engine
	execs  *fakeExecutor
	ws     *fakeProvisioner
	store  *fakeStore
	msgr   *fakeMessenger
	sess   *fakeOrphanSessions
	base   string

	mu  sync.Mutex
	now time.Time
}

// newHarness wires an engine over the fakes with a frozen clock and a
// deterministic run id, so every test drives time and ticks explicitly.
func newHarness(t *testing.T, opts ...func(*Config)) *harness {
	t.Helper()
	base := t.TempDir()
	h := &harness{
		execs: newFakeExecutor(),
		ws:    newFakeProvisioner(filepath.Join(base, "trees")),
		store: newFakeStore(),
		msgr:  &fakeMessenger{},
		sess:  newAutoOrphanSessions("proj-1"),
		base:  filepath.Join(base, "pipelines"),
		now:   time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC),
	}
	n := 0
	cfg := Config{
		ProjectID:  "proj-1",
		Store:      h.store,
		Executors:  h.execs,
		Workspaces: h.ws,
		Sessions:   h.sess,
		Orphans:    NewOrphanRegistry(h.sess, h.sess, nil),
		Messenger:  h.msgr,
		BaseDir:    h.base,
		Clock:      h.clock,
		NewRunID: func() pipeline.RunID {
			n++
			return pipeline.RunID("run-" + string(rune('a'+n-1)))
		},
		// Long enough that the internal ticker never fires: tests call Tick.
		TickInterval: time.Hour,
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	h.engine = New(cfg)
	if err := h.engine.Start(context.Background()); err != nil {
		t.Fatalf("start engine: %v", err)
	}
	t.Cleanup(func() { _ = h.engine.Stop(context.Background()) })
	return h
}

func (h *harness) clock() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.now
}

func (h *harness) advance(d time.Duration) {
	h.mu.Lock()
	h.now = h.now.Add(d)
	h.mu.Unlock()
}

// trigger starts a run from raw YAML, failing the test if the definition does
// not parse: a broken fixture must not read as an engine bug.
func (h *harness) trigger(t *testing.T, yamlSrc string, subject pipeline.Subject) pipeline.RunID {
	t.Helper()
	cfg, err := pipeline.ParseDefinition([]byte(yamlSrc))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	runID, err := h.engine.TriggerRun(triggers.TriggerRequest{
		Definition: pipeline.Definition{
			ID:         "pl-1",
			ProjectID:  "proj-1",
			Name:       cfg.Name,
			YAMLSource: yamlSrc,
			Config:     *cfg,
		},
		Event:   "manual",
		Subject: subject,
	})
	if err != nil {
		t.Fatalf("trigger run: %v", err)
	}
	return runID
}

func (h *harness) run(t *testing.T, id pipeline.RunID) pipeline.RunState {
	t.Helper()
	run, ok := h.engine.Run(id)
	if !ok {
		t.Fatalf("engine has no run %s", id)
	}
	return run
}

func (h *harness) outcome(t *testing.T, id pipeline.RunID, stage string) pipeline.Outcome {
	t.Helper()
	st := h.run(t, id).Stages[stage]
	if st == nil {
		t.Fatalf("run %s has no stage %q", id, stage)
	}
	return st.Outcome
}

// writeOutput fills a stage's declared artifact so VerifyArtifact passes.
func (h *harness) writeOutput(t *testing.T, id pipeline.RunID, name, body string) {
	t.Helper()
	path := filepath.Join(h.base, "proj-1", string(id), "agent-outputs", name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write artifact: %v", err)
	}
}

func userSessionSubject() pipeline.Subject {
	return pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: "proj-1", SessionID: "sess-user"}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const twoStageYAML = `
name: review-then-publish
stages:
  - id: review
    executor: agent
    agent: claude-code
    produces: review.md
    prompt: review the diff
    on_success: publish
  - id: publish
    executor: command
    run: echo published
`

const failureRouteYAML = `
name: build-and-diagnose
stages:
  - id: build
    executor: command
    run: make build
    on_failure: diagnose
  - id: diagnose
    executor: agent
    agent: claude-code
    prompt: work out why the build failed
`

const joinYAML = `
name: fan-in
stages:
  - id: prepare
    executor: command
    run: echo prepare
    on_success: [lint, test]
  - id: lint
    executor: command
    run: echo lint
    on_success: report
  - id: test
    executor: command
    run: echo test
    on_success: report
  - id: report
    executor: agent
    agent: claude-code
    prompt: summarize
    needs: [lint, test]
`

const sessionWorkspaceYAML = `
name: needs-a-session
stages:
  - id: review
    executor: agent
    agent: claude-code
    workspace: session
    prompt: review it
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestHappyPathRunSettlesSucceeded is the whole loop end to end: an agent stage
// that honours its produces contract, then a command stage that exits 0.
func TestHappyPathRunSettlesSucceeded(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())

	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeRunning {
		t.Fatalf("review outcome = %q, want running", got)
	}
	if got := h.outcome(t, runID, "publish"); got != pipeline.OutcomePending {
		t.Fatalf("publish outcome = %q, want pending", got)
	}

	h.writeOutput(t, runID, "review.md", "looks fine")
	h.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h.engine.Tick()

	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeSucceeded {
		t.Fatalf("review outcome = %q, want succeeded", got)
	}
	h.execs.script(t, "publish", executors.Poll{State: executors.PollExited, ExitCode: 0})
	h.engine.Tick()

	run := h.run(t, runID)
	if run.Status != pipeline.RunSucceeded {
		t.Fatalf("run status = %q, want succeeded", run.Status)
	}

	// Context.md carries the pointer line for the verified artifact.
	ctxRaw, err := os.ReadFile(filepath.Join(h.base, "proj-1", string(runID), "Context.md"))
	if err != nil {
		t.Fatalf("read Context.md: %v", err)
	}
	want := "stage `review` finished, its output is at agent-outputs/review.md"
	if !strings.Contains(string(ctxRaw), want) {
		t.Fatalf("Context.md = %q, want it to contain %q", ctxRaw, want)
	}

	// run.json is the on-disk projection, and the store is the record. The run
	// number is allocated by the store, so its presence here is what proves the
	// engine took it back before writing the projection humans read.
	runJSON, err := os.ReadFile(filepath.Join(h.base, "proj-1", string(runID), "run.json"))
	if err != nil {
		t.Fatalf("run.json: %v", err)
	}
	if !strings.Contains(string(runJSON), `"runNumber": 1`) {
		t.Fatalf("run.json carries no run number: %s", runJSON)
	}
	if run.RunNumber != 1 {
		t.Fatalf("engine run number = %d, want 1", run.RunNumber)
	}
	saved, ok := h.store.saved(runID)
	if !ok || saved.Status != pipeline.RunSucceeded {
		t.Fatalf("store has %+v, want a succeeded run", saved.Status)
	}
	// The frozen definition is what actually ran.
	frozen, err := os.ReadFile(filepath.Join(h.base, "proj-1", string(runID), "definition.yaml"))
	if err != nil {
		t.Fatalf("read frozen definition: %v", err)
	}
	if string(frozen) != twoStageYAML {
		t.Fatalf("frozen definition does not match the source YAML")
	}
}

// TestNudgeRoundTrip walks the one nudge a stage gets: done with no artifact,
// the spec's message into the live session, attempt 2, then a real settlement.
func TestNudgeRoundTrip(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())

	h.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h.engine.Tick()

	msgs := h.msgr.messages()
	if len(msgs) != 1 {
		t.Fatalf("messenger got %v, want exactly one nudge", msgs)
	}
	if !strings.Contains(msgs[0], "agent-outputs/review.md does not exist or is empty") {
		t.Fatalf("nudge message = %q", msgs[0])
	}
	if !strings.HasPrefix(msgs[0], "sess-review: ") {
		t.Fatalf("nudge went to %q, want the stage's own session", msgs[0])
	}

	run := h.run(t, runID)
	if got := run.Stages["review"].Outcome; got != pipeline.OutcomeRunning {
		t.Fatalf("review outcome = %q, want it to stay running through the nudge", got)
	}
	if got := run.Stages["review"].Attempt; got != 2 {
		t.Fatalf("review attempt = %d, want 2 after the nudge was delivered", got)
	}

	// The agent answers the nudge: artifact written, signal repeated.
	h.writeOutput(t, runID, "review.md", "now with content")
	h.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h.engine.Tick()
	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeSucceeded {
		t.Fatalf("review outcome = %q, want succeeded after the nudge", got)
	}
}

// TestNudgeSpentSettlesNoOutput is the second arrival at the same dead end: two
// attempts total, then the stage settles no_output.
func TestNudgeSpentSettlesNoOutput(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())

	h.execs.script(t, "review",
		executors.Poll{State: executors.PollSignaledDone},
		executors.Poll{State: executors.PollSignaledDone},
	)
	h.engine.Tick()
	h.engine.Tick()

	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeNoOutput {
		t.Fatalf("review outcome = %q, want no_output", got)
	}
	if got := h.outcome(t, runID, "publish"); got != pipeline.OutcomeSkipped {
		t.Fatalf("publish outcome = %q, want skipped", got)
	}
	if run := h.run(t, runID); run.Status != pipeline.RunFailed {
		t.Fatalf("run status = %q, want failed", run.Status)
	}
	// no_output is not in the default kill-on set: the session is kept so a
	// human can see what the agent was doing.
	if killed := h.sess.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v, want the session kept on no_output", killed)
	}
}

// TestDeadlineTimesOutAndInterrupts checks the tick path: a stage past its
// deadline settles timed_out, its process is interrupted, and the session is
// kept.
func TestDeadlineTimesOutAndInterrupts(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())

	h.advance(pipeline.DefaultStageDeadline + time.Minute)
	h.engine.Tick()

	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeTimedOut {
		t.Fatalf("review outcome = %q, want timed_out", got)
	}
	if !h.execs.handle(t, "review").interrupted {
		t.Fatal("timed-out stage was not interrupted")
	}
	if killed := h.sess.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v, want the session kept on timed_out", killed)
	}
	if run := h.run(t, runID); run.Status != pipeline.RunFailed {
		t.Fatalf("run status = %q, want failed", run.Status)
	}
}

// TestCancelMidRun tears a running run down: the running stage is cancelled and
// its executor torn down, the pending stage is skipped, nothing routes.
func TestCancelMidRun(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())

	h.engine.Cancel(runID, "user asked")

	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeCancelled {
		t.Fatalf("review outcome = %q, want cancelled", got)
	}
	if got := h.outcome(t, runID, "publish"); got != pipeline.OutcomeSkipped {
		t.Fatalf("publish outcome = %q, want skipped", got)
	}
	if !h.execs.handle(t, "review").cancelled {
		t.Fatal("cancelled stage's executor was not torn down")
	}
	run := h.run(t, runID)
	if run.Status != pipeline.RunCancelled {
		t.Fatalf("run status = %q, want cancelled", run.Status)
	}
	if run.CancelReason != "user asked" {
		t.Fatalf("cancel reason = %q", run.CancelReason)
	}
}

// TestPlanFailureSettlesWithoutStartingAnything is the point of planning at
// start: the one impossible workspace combination fails the run before any
// stage runs, with the reason stated, and the run folder is kept.
func TestPlanFailureSettlesWithoutStartingAnything(t *testing.T) {
	h := newHarness(t)
	subject := pipeline.Subject{
		Kind:      pipeline.SubjectPR,
		ProjectID: "proj-1",
		PR:        &pipeline.PRRef{Number: 412, Repo: "acme/app", HeadSHA: "deadbeef"},
	}
	runID := h.trigger(t, sessionWorkspaceYAML, subject)

	run := h.run(t, runID)
	if run.Status != pipeline.RunFailed {
		t.Fatalf("run status = %q, want failed", run.Status)
	}
	st := run.Stages["review"]
	if st == nil || st.Outcome != pipeline.OutcomeFailed {
		t.Fatalf("review stage = %+v, want failed", st)
	}
	want := "stage 'review' requires workspace 'session'; PR #412 has no local session"
	if st.Reason != want {
		t.Fatalf("reason = %q, want %q", st.Reason, want)
	}
	if ids := h.execs.startedIDs(); len(ids) != 0 {
		t.Fatalf("started %v, want no stage started on a plan failure", ids)
	}
	if _, err := os.Stat(filepath.Join(h.base, "proj-1", string(runID))); err != nil {
		t.Fatalf("run folder must be kept on a plan failure: %v", err)
	}
	if saved, ok := h.store.saved(runID); !ok || saved.Status != pipeline.RunFailed {
		t.Fatalf("plan failure was not persisted (%+v)", saved)
	}
}

// TestRestartSettlesLostRunningStage is decision D16: a daemon restart cannot
// resume a Poll loop, so a stage persisted running settles honestly and the
// run routes its failure edge.
func TestRestartSettlesLostRunningStage(t *testing.T) {
	base := t.TempDir()
	store := newFakeStore()
	cfg, err := pipeline.ParseDefinition([]byte(failureRouteYAML))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	// An agent stage the previous process left running, plus the failure target
	// still pending.
	lost := pipeline.RunState{
		RunID:        "run-lost",
		ProjectID:    "proj-1",
		PipelineName: cfg.Name,
		Subject:      userSessionSubject(),
		Status:       pipeline.RunRunning,
		RunDir:       filepath.Join(base, "pipelines", "proj-1", "run-lost"),
		Def:          *cfg,
		Stages: map[string]*pipeline.StageState{
			"build":    {ID: "build", Outcome: pipeline.OutcomeSucceeded, Attempt: 1},
			"diagnose": {ID: "diagnose", Outcome: pipeline.OutcomeRunning, Attempt: 1, SessionID: "sess-old"},
		},
	}
	store.hydra = []pipeline.RunState{lost}
	if err := os.MkdirAll(lost.RunDir, 0o750); err != nil {
		t.Fatalf("seed run dir: %v", err)
	}

	execs := newFakeExecutor()
	eng := New(Config{
		ProjectID:    "proj-1",
		Store:        store,
		Executors:    execs,
		Workspaces:   newFakeProvisioner(filepath.Join(base, "trees")),
		Sessions:     &fakeSessions{},
		Messenger:    &fakeMessenger{},
		BaseDir:      filepath.Join(base, "pipelines"),
		Clock:        func() time.Time { return time.Date(2026, 7, 26, 13, 0, 0, 0, time.UTC) },
		TickInterval: time.Hour,
	})
	if err := eng.Start(context.Background()); err != nil {
		t.Fatalf("start engine: %v", err)
	}
	t.Cleanup(func() { _ = eng.Stop(context.Background()) })

	run, ok := eng.Run("run-lost")
	if !ok {
		t.Fatal("hydrated run is missing")
	}
	if got := run.Stages["diagnose"].Outcome; got != pipeline.OutcomeNoSignal {
		t.Fatalf("diagnose outcome = %q, want no_signal for a lost agent stage", got)
	}
	if run.Status != pipeline.RunFailed {
		t.Fatalf("run status = %q, want failed", run.Status)
	}
	if ids := execs.startedIDs(); len(ids) != 0 {
		t.Fatalf("started %v, want nothing restarted after a lost stage", ids)
	}
}

// TestRestartSettlesLostCommandStageAsFailed is the command half of D16: a
// process handle is gone for good, and failed (not no_signal) is the honest
// outcome.
func TestRestartSettlesLostCommandStageAsFailed(t *testing.T) {
	base := t.TempDir()
	store := newFakeStore()
	cfg, err := pipeline.ParseDefinition([]byte(failureRouteYAML))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	store.hydra = []pipeline.RunState{{
		RunID:        "run-lost",
		ProjectID:    "proj-1",
		PipelineName: cfg.Name,
		Subject:      userSessionSubject(),
		Status:       pipeline.RunRunning,
		RunDir:       filepath.Join(base, "pipelines", "proj-1", "run-lost"),
		Def:          *cfg,
		Stages: map[string]*pipeline.StageState{
			"build":    {ID: "build", Outcome: pipeline.OutcomeRunning, Attempt: 1},
			"diagnose": {ID: "diagnose", Outcome: pipeline.OutcomePending},
		},
	}}
	if err := os.MkdirAll(filepath.Join(base, "pipelines", "proj-1", "run-lost"), 0o750); err != nil {
		t.Fatalf("seed run dir: %v", err)
	}

	execs := newFakeExecutor()
	eng := New(Config{
		ProjectID:    "proj-1",
		Store:        store,
		Executors:    execs,
		Workspaces:   newFakeProvisioner(filepath.Join(base, "trees")),
		Sessions:     &fakeSessions{},
		Messenger:    &fakeMessenger{},
		BaseDir:      filepath.Join(base, "pipelines"),
		TickInterval: time.Hour,
	})
	if err := eng.Start(context.Background()); err != nil {
		t.Fatalf("start engine: %v", err)
	}
	t.Cleanup(func() { _ = eng.Stop(context.Background()) })

	run, _ := eng.Run("run-lost")
	if got := run.Stages["build"].Outcome; got != pipeline.OutcomeFailed {
		t.Fatalf("build outcome = %q, want failed for a lost command stage", got)
	}
	// The failure routed: diagnose is the on_failure target and it started.
	if got := run.Stages["diagnose"].Outcome; got == pipeline.OutcomeSkipped {
		t.Fatalf("diagnose outcome = %q, want the failure edge taken", got)
	}
	if ids := execs.startedIDs(); len(ids) != 1 || ids[0] != "diagnose" {
		t.Fatalf("started %v, want the failure target", ids)
	}
}

// A launched command stage records the process group it runs in. That id is
// the only thing a later daemon can find the work by, so it has to be on the
// stage before anything else can go wrong.
func TestLaunchedCommandStageRecordsItsProcessGroup(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, failureRouteYAML, userSessionSubject())

	run, _ := h.engine.Run(runID)
	if got := run.Stages["build"].PGID; got != fakeHandlePGID {
		t.Fatalf("build pgid = %d, want %d from the command handle", got, fakeHandlePGID)
	}
	if run.Stages["build"].StartedAt.IsZero() {
		t.Fatal("a recorded pgid with no start time cannot be identity checked")
	}
}

// The leak this fixes: reconciliation settled the stage and left its process
// running. The reap goes first, and its finding is in the reason, so the stage
// says what actually happened to the work it was doing.
func TestRestartReapsALostCommandStageProcessGroup(t *testing.T) {
	base := t.TempDir()
	store := newFakeStore()
	cfg, err := pipeline.ParseDefinition([]byte(failureRouteYAML))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	launchedAt := time.Date(2026, 7, 26, 12, 30, 0, 0, time.UTC)
	store.hydra = []pipeline.RunState{{
		RunID:        "run-lost",
		ProjectID:    "proj-1",
		PipelineName: cfg.Name,
		Subject:      userSessionSubject(),
		Status:       pipeline.RunRunning,
		RunDir:       filepath.Join(base, "pipelines", "proj-1", "run-lost"),
		Def:          *cfg,
		Stages: map[string]*pipeline.StageState{
			"build":    {ID: "build", Outcome: pipeline.OutcomeRunning, Attempt: 1, StartedAt: launchedAt, PGID: 48211},
			"diagnose": {ID: "diagnose", Outcome: pipeline.OutcomePending},
		},
	}}
	if err := os.MkdirAll(filepath.Join(base, "pipelines", "proj-1", "run-lost"), 0o750); err != nil {
		t.Fatalf("seed run dir: %v", err)
	}

	reaper := &fakeReaper{clause: "its process group 48211 was still alive and has been killed"}
	eng := New(Config{
		ProjectID:     "proj-1",
		Store:         store,
		Executors:     newFakeExecutor(),
		Workspaces:    newFakeProvisioner(filepath.Join(base, "trees")),
		Sessions:      &fakeSessions{},
		Messenger:     &fakeMessenger{},
		ProcessGroups: reaper,
		BaseDir:       filepath.Join(base, "pipelines"),
		TickInterval:  time.Hour,
	})
	if err := eng.Start(context.Background()); err != nil {
		t.Fatalf("start engine: %v", err)
	}
	t.Cleanup(func() { _ = eng.Stop(context.Background()) })

	calls := reaper.reaped()
	if len(calls) != 1 {
		t.Fatalf("reaped %d groups, want exactly the lost command stage's", len(calls))
	}
	// The pair the identity check runs on: the persisted group and the moment
	// the stage recorded launching it.
	if calls[0].pgid != 48211 || !calls[0].startedAt.Equal(launchedAt) {
		t.Fatalf("reaped (%d, %s), want (48211, %s)", calls[0].pgid, calls[0].startedAt, launchedAt)
	}

	run, _ := eng.Run("run-lost")
	if got := run.Stages["build"].Outcome; got != pipeline.OutcomeFailed {
		t.Fatalf("build outcome = %q, want failed", got)
	}
	if got := run.Stages["build"].Reason; !strings.Contains(got, reaper.clause) {
		t.Fatalf("build reason = %q, want it to carry what the reap found", got)
	}
}

// An agent stage is a session, and session teardown already owns it: a reap
// keyed on a stage that never recorded a process group has nothing right to
// kill.
func TestRestartDoesNotReapALostAgentStage(t *testing.T) {
	base := t.TempDir()
	store := newFakeStore()
	cfg, err := pipeline.ParseDefinition([]byte(failureRouteYAML))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	store.hydra = []pipeline.RunState{{
		RunID:        "run-lost",
		ProjectID:    "proj-1",
		PipelineName: cfg.Name,
		Subject:      userSessionSubject(),
		Status:       pipeline.RunRunning,
		RunDir:       filepath.Join(base, "pipelines", "proj-1", "run-lost"),
		Def:          *cfg,
		Stages: map[string]*pipeline.StageState{
			"build":    {ID: "build", Outcome: pipeline.OutcomeSucceeded, Attempt: 1},
			"diagnose": {ID: "diagnose", Outcome: pipeline.OutcomeRunning, Attempt: 1, SessionID: "sess-old"},
		},
	}}
	if err := os.MkdirAll(filepath.Join(base, "pipelines", "proj-1", "run-lost"), 0o750); err != nil {
		t.Fatalf("seed run dir: %v", err)
	}

	reaper := &fakeReaper{}
	eng := New(Config{
		ProjectID:     "proj-1",
		Store:         store,
		Executors:     newFakeExecutor(),
		Workspaces:    newFakeProvisioner(filepath.Join(base, "trees")),
		Sessions:      &fakeSessions{},
		Messenger:     &fakeMessenger{},
		ProcessGroups: reaper,
		BaseDir:       filepath.Join(base, "pipelines"),
		TickInterval:  time.Hour,
	})
	if err := eng.Start(context.Background()); err != nil {
		t.Fatalf("start engine: %v", err)
	}
	t.Cleanup(func() { _ = eng.Stop(context.Background()) })

	if calls := reaper.reaped(); len(calls) != 0 {
		t.Fatalf("reaped %+v, want nothing for an agent stage", calls)
	}
	run, _ := eng.Run("run-lost")
	if got := run.Stages["diagnose"].Outcome; got != pipeline.OutcomeNoSignal {
		t.Fatalf("diagnose outcome = %q, want no_signal", got)
	}
}

// TestAmbientEnvAlwaysPresent pins the seven variables the spec's section 12.2
// table marks "always". Anything a `run:` block or a prompt can rely on
// unconditionally has to actually be there: the starter templates interpolate
// $AO_RUN_DIR, and AO_RUN_ID plus AO_STAGE are what `ao pipeline done` resolves
// itself from.
func TestAmbientEnvAlwaysPresent(t *testing.T) {
	h := newHarness(t)
	// A project subject: no session, no PR, so only the always-present set and
	// the workspace can resolve.
	runID := h.trigger(t, joinYAML, pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj-1"})

	in := h.execs.handle(t, "prepare").in
	runDir := filepath.Join(h.base, "proj-1", string(runID))
	want := map[string]string{
		"AO_PROJECT":   "proj-1",
		"AO_RUN_ID":    string(runID),
		"AO_RUN_DIR":   runDir,
		"AO_STAGE":     "prepare",
		"AO_ATTEMPT":   "1",
		"AO_CONTEXT":   filepath.Join(runDir, "Context.md"),
		"AO_WORKSPACE": in.WorkspacePath,
	}
	for key, value := range want {
		got, ok := in.Env[key]
		if !ok {
			t.Errorf("%s is unset, but the spec table marks it always present", key)
			continue
		}
		if got != value {
			t.Errorf("%s = %q, want %q", key, got, value)
		}
	}
	if in.Env["AO_WORKSPACE"] == "" {
		t.Error("AO_WORKSPACE is empty, want the resolved tree")
	}
	// Nothing that cannot resolve for this subject leaked in.
	for _, key := range []string{"AO_SESSION_ID", "AO_PR_NUMBER", "AO_PR_REPO", "AO_PR_HEAD", "AO_OUTPUT", "AO_PREV_STAGE", "AO_FAILED_STAGE"} {
		if got, ok := in.Env[key]; ok {
			t.Errorf("%s = %q, want unset for a project subject at the entry stage", key, got)
		}
	}
}

// TestAmbientEnvOnFailureEntry covers the failure-entry half of the spec's
// ambient table, including the inherited tree.
func TestAmbientEnvOnFailureEntry(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, failureRouteYAML, userSessionSubject())

	h.execs.script(t, "build", executors.Poll{State: executors.PollExited, ExitCode: 2})
	h.engine.Tick()

	env := h.execs.handle(t, "diagnose").in.Env
	if env["AO_FAILED_STAGE"] != "build" {
		t.Fatalf("AO_FAILED_STAGE = %q, want build", env["AO_FAILED_STAGE"])
	}
	if env["AO_FAILED_OUTCOME"] != string(pipeline.OutcomeFailed) {
		t.Fatalf("AO_FAILED_OUTCOME = %q", env["AO_FAILED_OUTCOME"])
	}
	if _, ok := env["AO_PREV_STAGE"]; ok {
		t.Fatalf("AO_PREV_STAGE = %q, want unset on a failure entry", env["AO_PREV_STAGE"])
	}
	if _, ok := env["AO_OUTPUT"]; ok {
		t.Fatalf("AO_OUTPUT = %q, want unset without produces", env["AO_OUTPUT"])
	}
	if env["AO_RUN_ID"] != string(runID) || env["AO_STAGE"] != "diagnose" {
		t.Fatalf("identity env = %q/%q, want the two `ao pipeline done` resolves itself from", env["AO_RUN_ID"], env["AO_STAGE"])
	}
	if env["AO_ATTEMPT"] != "1" {
		t.Fatalf("AO_ATTEMPT = %q, want 1", env["AO_ATTEMPT"])
	}
	if env["AO_CONTEXT"] != filepath.Join(h.base, "proj-1", string(runID), "Context.md") {
		t.Fatalf("AO_CONTEXT = %q", env["AO_CONTEXT"])
	}
	if env["AO_SESSION_ID"] != "sess-user" {
		t.Fatalf("AO_SESSION_ID = %q, want the subject's session", env["AO_SESSION_ID"])
	}
	// inherit resolves to the failed stage's tree (spec section 5.4).
	req := h.lastRequest(t, "diagnose")
	if req.Kind != pipeline.WorkspaceInherit {
		t.Fatalf("diagnose workspace kind = %q, want inherit", req.Kind)
	}
	if req.InheritPath != h.execs.handle(t, "build").in.WorkspacePath {
		t.Fatalf("inherit path = %q, want the failed stage's tree", req.InheritPath)
	}
}

// TestAmbientEnvAtJoinAndOnSuccess: AO_PREV_* resolves for a sole predecessor
// and is unset at a join, where it would be ambiguous.
func TestAmbientEnvAtJoinAndOnSuccess(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, joinYAML, userSessionSubject())

	h.execs.script(t, "prepare", executors.Poll{State: executors.PollExited, ExitCode: 0})
	h.engine.Tick()

	lint := h.execs.handle(t, "lint").in.Env
	if lint["AO_PREV_STAGE"] != "prepare" {
		t.Fatalf("AO_PREV_STAGE = %q, want prepare", lint["AO_PREV_STAGE"])
	}
	if lint["AO_PREV_OUTCOME"] != string(pipeline.OutcomeSucceeded) {
		t.Fatalf("AO_PREV_OUTCOME = %q", lint["AO_PREV_OUTCOME"])
	}

	h.execs.script(t, "lint", executors.Poll{State: executors.PollExited, ExitCode: 0})
	h.execs.script(t, "test", executors.Poll{State: executors.PollExited, ExitCode: 0})
	h.engine.Tick()

	report := h.execs.handle(t, "report").in.Env
	if _, ok := report["AO_PREV_STAGE"]; ok {
		t.Fatalf("AO_PREV_STAGE = %q, want unset at a join", report["AO_PREV_STAGE"])
	}
	if _, ok := report["AO_PREV_OUTCOME"]; ok {
		t.Fatalf("AO_PREV_OUTCOME = %q, want unset at a join", report["AO_PREV_OUTCOME"])
	}
	if _, ok := report["AO_OUTPUT"]; ok {
		t.Fatalf("AO_OUTPUT = %q, want unset without produces", report["AO_OUTPUT"])
	}
	_ = runID
}

// TestPRSubjectEnvAndCredentials: PR variables resolve for a PR subject, and
// credentials reach a command stage only.
func TestPRSubjectEnvAndCredentials(t *testing.T) {
	const yamlSrc = `
name: publish
stages:
  - id: publish
    executor: command
    run: gh release create
    credentials: [github-release]
`
	creds := fakeCredentials{values: map[string]map[string]string{
		"github-release": {"GH_TOKEN": "s3cret"},
	}}
	h := newHarness(t, func(c *Config) { c.Credentials = creds })
	subject := pipeline.Subject{
		Kind:      pipeline.SubjectPR,
		ProjectID: "proj-1",
		SessionID: "sess-pr",
		PR:        &pipeline.PRRef{Number: 7, Repo: "acme/app", HeadSHA: "abc123", HeadBranch: "feature"},
	}
	h.trigger(t, yamlSrc, subject)

	in := h.execs.handle(t, "publish").in
	if in.Env["AO_PR_NUMBER"] != "7" || in.Env["AO_PR_REPO"] != "acme/app" || in.Env["AO_PR_HEAD"] != "abc123" {
		t.Fatalf("PR env = %v", in.Env)
	}
	if in.Credentials["GH_TOKEN"] != "s3cret" {
		t.Fatalf("credentials = %v, want the resolved value on a command stage", in.Credentials)
	}
}

// TestAgentStageNeverReceivesCredentials is the runtime half of the tier rule:
// the driver resolves credentials for command stages only.
func TestAgentStageNeverReceivesCredentials(t *testing.T) {
	creds := fakeCredentials{values: map[string]map[string]string{"anything": {"K": "V"}}}
	h := newHarness(t, func(c *Config) { c.Credentials = creds })
	h.trigger(t, twoStageYAML, userSessionSubject())

	if got := h.execs.handle(t, "review").in.Credentials; len(got) != 0 {
		t.Fatalf("agent stage got credentials %v", got)
	}
}

// TestOwnedWorkspacesDestroyedOnlyOnSuccess is spec section 5.5: owned trees go
// away on success and are kept on failure, same rule as sessions.
func TestOwnedWorkspacesDestroyedOnlyOnSuccess(t *testing.T) {
	const yamlSrc = `
name: one-command
stages:
  - id: build
    executor: command
    workspace: run
    run: make
`
	t.Run("succeeded destroys", func(t *testing.T) {
		h := newHarness(t)
		h.trigger(t, yamlSrc, pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj-1"})
		h.execs.script(t, "build", executors.Poll{State: executors.PollExited, ExitCode: 0})
		h.engine.Tick()
		if got := h.ws.destroyedPaths(); len(got) != 1 {
			t.Fatalf("destroyed %v, want the run's owned tree", got)
		}
	})

	t.Run("failed keeps", func(t *testing.T) {
		h := newHarness(t)
		h.trigger(t, yamlSrc, pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj-1"})
		h.execs.script(t, "build", executors.Poll{State: executors.PollExited, ExitCode: 1})
		h.engine.Tick()
		if got := h.ws.destroyedPaths(); len(got) != 0 {
			t.Fatalf("destroyed %v, want owned trees kept on failure", got)
		}
	})
}

// A tree a spared session is still living in is not destroyed, even on a
// successful run. Agent stages run in the resolved tree, so removing it under a
// session `kill-on: []` deliberately kept would delete the working directory of
// the pane the author asked to keep.
func TestOwnedWorkspaceKeptWhileASparedSessionLivesInIt(t *testing.T) {
	const yamlSrc = `
name: keep-session-and-tree
stages:
  - id: review
    executor: agent
    agent: claude-code
    prompt: review
    workspace: run
    session:
      kill-on: []
`
	h := newHarness(t)
	runID := h.trigger(t, yamlSrc, userSessionSubject())
	h.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h.engine.Tick()

	if got := h.run(t, runID).Status; got != pipeline.RunSucceeded {
		t.Fatalf("run status = %q, want succeeded", got)
	}
	if killed := h.sess.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v, want kill-on: [] to keep the session", killed)
	}
	if got := h.ws.destroyedPaths(); len(got) != 0 {
		t.Fatalf("destroyed %v, want the tree kept while the spared session is in it", got)
	}
}

// TestKillOnDisposition: the default kills on succeeded, an explicit empty list
// never does.
func TestKillOnDisposition(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())
	h.writeOutput(t, runID, "review.md", "content")
	h.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h.engine.Tick()

	if killed := h.sess.killedIDs(); len(killed) != 1 || killed[0] != "sess-review" {
		t.Fatalf("killed %v, want the stage session killed on succeeded", killed)
	}

	const keepYAML = `
name: keep-session
stages:
  - id: review
    executor: agent
    agent: claude-code
    prompt: review
    session:
      kill-on: []
`
	h2 := newHarness(t)
	h2.trigger(t, keepYAML, userSessionSubject())
	h2.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h2.engine.Tick()
	if killed := h2.sess.killedIDs(); len(killed) != 0 {
		t.Fatalf("killed %v, want kill-on: [] to never kill", killed)
	}

	// A stage with no `produces:` settles succeeded_unverified and can never
	// settle succeeded, so the default kill-on has to cover it or every clean
	// run of an unverified stage leaks its session.
	const unverifiedYAML = `
name: unverified-session
stages:
  - id: review
    executor: agent
    agent: claude-code
    prompt: review
`
	h3 := newHarness(t)
	h3.trigger(t, unverifiedYAML, userSessionSubject())
	h3.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h3.engine.Tick()
	if killed := h3.sess.killedIDs(); len(killed) != 1 || killed[0] != "sess-review" {
		t.Fatalf("killed %v, want the session killed on succeeded_unverified", killed)
	}
}

// TestKeptSessionIsMarkedPipelineOrphaned: the kept half of the kill-on rule.
// The session survives no_output and carries the run, the stage and the outcome
// that spared it, because a kept session nobody can find is the leak this
// feature exists to stop.
func TestKeptSessionIsMarkedPipelineOrphaned(t *testing.T) {
	h := newHarness(t)
	runID := h.trigger(t, twoStageYAML, userSessionSubject())

	h.execs.script(t, "review",
		executors.Poll{State: executors.PollSignaledDone},
		executors.Poll{State: executors.PollSignaledDone},
	)
	h.engine.Tick()
	h.engine.Tick()

	if got := h.outcome(t, runID, "review"); got != pipeline.OutcomeNoOutput {
		t.Fatalf("review outcome = %q, want no_output", got)
	}
	marker := h.sess.marker("sess-review")
	if marker == nil {
		t.Fatal("kept session was not marked pipeline-orphaned")
	}
	want := domain.PipelineOrphanInfo{
		RunID:    string(runID),
		Stage:    "review",
		Outcome:  string(pipeline.OutcomeNoOutput),
		KeptAt:   h.clock(),
		Pipeline: h.run(t, runID).PipelineName,
	}
	if *marker != want {
		t.Fatalf("orphan marker = %+v, want %+v", *marker, want)
	}

	// A killed session is not an orphan: the marker exists to explain a session
	// that is still there.
	h2 := newHarness(t)
	killed := h2.trigger(t, twoStageYAML, userSessionSubject())
	h2.writeOutput(t, killed, "review.md", "content")
	h2.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h2.engine.Tick()
	if got := h2.sess.marker("sess-review"); got != nil {
		t.Fatalf("killed session marked pipeline-orphaned: %+v", got)
	}
}

// TestLaunchFailureRoutesLikeAnyFailure: a workspace that cannot be provisioned
// settles the stage failed with the reason stated, and takes the failure edge.
func TestLaunchFailureRoutesLikeAnyFailure(t *testing.T) {
	h := newHarness(t)
	h.ws.failOn["build"] = errors.New("no such ref")
	runID := h.trigger(t, failureRouteYAML, userSessionSubject())

	st := h.run(t, runID).Stages["build"]
	if st.Outcome != pipeline.OutcomeFailed {
		t.Fatalf("build outcome = %q, want failed", st.Outcome)
	}
	if !strings.Contains(st.Reason, "no such ref") {
		t.Fatalf("reason = %q, want the provisioning error", st.Reason)
	}
	if got := h.outcome(t, runID, "diagnose"); got == pipeline.OutcomeSkipped {
		t.Fatal("failure edge was not taken after a launch failure")
	}
}

// TestConcurrencySerializesSameKey: a second trigger for the same key queues at
// depth 1 and starts when the holder settles.
func TestConcurrencySerializesSameKey(t *testing.T) {
	h := newHarness(t)
	first := h.trigger(t, twoStageYAML, userSessionSubject())
	second := h.trigger(t, twoStageYAML, userSessionSubject())

	if _, ok := h.engine.Run(second); ok {
		t.Fatal("second run started while the first held the key")
	}

	h.writeOutput(t, first, "review.md", "done")
	h.execs.script(t, "review", executors.Poll{State: executors.PollSignaledDone})
	h.engine.Tick()
	h.execs.script(t, "publish", executors.Poll{State: executors.PollExited, ExitCode: 0})
	h.engine.Tick()

	// The queued trigger starts off the actor goroutine, so give it a moment.
	waitFor(t, func() bool { _, ok := h.engine.Run(second); return ok })
}

// lastRequest returns the newest workspace request for a stage.
func (h *harness) lastRequest(t *testing.T, stage string) executors.WorkspaceRequest {
	t.Helper()
	h.ws.mu.Lock()
	defer h.ws.mu.Unlock()
	for i := len(h.ws.requests) - 1; i >= 0; i-- {
		if h.ws.requests[i].StageID == stage {
			return h.ws.requests[i]
		}
	}
	t.Fatalf("no workspace request for stage %q", stage)
	return executors.WorkspaceRequest{}
}

// waitFor polls cond until it holds or the test times out. Only the queued
// trigger path is asynchronous; everything else is driven synchronously.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition never held")
}
