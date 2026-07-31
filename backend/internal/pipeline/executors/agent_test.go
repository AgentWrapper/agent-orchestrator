package executors

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// fakeSpawner is the session seam under test control: it records the spawn
// request, hands back whatever snapshot the test set, and counts kills and
// interrupts separately so the session-preserving interrupt is observable.
type fakeSpawner struct {
	mu sync.Mutex

	req      SpawnRequest
	spawns   int
	spawned  SpawnedSession
	spawnErr error

	snap   SessionSnapshot
	exists bool
	getErr error

	kills      int
	interrupts int
}

func newFakeSpawner() *fakeSpawner {
	return &fakeSpawner{
		spawned: SpawnedSession{SessionID: "sess-1", WorkspacePath: "/tmp/tree"},
		snap:    SessionSnapshot{Activity: domain.ActivityActive},
		exists:  true,
	}
}

func (s *fakeSpawner) Spawn(_ context.Context, req SpawnRequest) (SpawnedSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.req = req
	s.spawns++
	if s.spawnErr != nil {
		return SpawnedSession{}, s.spawnErr
	}
	return s.spawned, nil
}

func (s *fakeSpawner) Get(_ context.Context, _ string) (SessionSnapshot, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snap, s.exists, s.getErr
}

func (s *fakeSpawner) Interrupt(_ context.Context, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.interrupts++
	return nil
}

func (s *fakeSpawner) Kill(_ context.Context, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kills++
	return nil
}

// activity sets what the next Get reports for a session that has already
// reported at least one hook callback, which is the state every reading other
// than the spawn window describes.
func (s *fakeSpawner) activity(state domain.ActivityState, exists bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snap = SessionSnapshot{Activity: state, Signalled: true}
	s.exists = exists
}

func (s *fakeSpawner) request() SpawnRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.req
}

func (s *fakeSpawner) counts() (kills, interrupts int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kills, s.interrupts
}

// fakeSignals is the registry Task 11 implements on the Manager.
type fakeSignals struct {
	mu  sync.Mutex
	sig pipeline.StageSignal
	ok  bool
}

func (r *fakeSignals) LatestSignal(_ pipeline.RunID, _ string) (pipeline.StageSignal, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sig, r.ok
}

func (r *fakeSignals) set(kind pipeline.SignalKind, reason string, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sig = pipeline.StageSignal{RunID: "run-1", StageID: "review", Kind: kind, Reason: reason, CreatedAt: at}
	r.ok = true
}

// fakeMessenger stands in for the driver's nudge seam. The executor never
// nudges (the engine executes NudgeStage effects), so nothing here is wired
// into the executor; this only pins the interface shape Task 15 adapts.
type fakeMessenger struct{ sent []string }

func (m *fakeMessenger) Alive(context.Context, string) (bool, error) { return true, nil }

func (m *fakeMessenger) Send(_ context.Context, _, message string) error {
	m.sent = append(m.sent, message)
	return nil
}

var _ SessionMessenger = (*fakeMessenger)(nil)

// agentInput builds an agent stage rooted in a real run folder, with an
// upstream pointer line already in Context.md.
func agentInput(t *testing.T) StartInput {
	t.Helper()
	folder, err := pipeline.CreateRunFolder(t.TempDir(), "proj-1", "run-1", []byte("stages: []\n"))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}
	if err := folder.AppendContext("stage `build` finished, its output is at agent-outputs/build.md"); err != nil {
		t.Fatalf("AppendContext: %v", err)
	}
	stage := pipeline.Stage{
		ID:       "review",
		Executor: pipeline.ExecutorAgent,
		Agent:    "claude-code",
		Produces: "review.md",
		Prompt:   "Review the diff.",
	}
	return StartInput{
		ProjectID:     "proj-1",
		RunID:         "run-1",
		RunDir:        folder.Dir,
		Stage:         stage,
		Attempt:       1,
		Subject:       pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj-1"},
		WorkspacePath: "/tmp/tree",
		Env: map[string]string{
			"AO_RUN_ID": "run-1",
			"AO_STAGE":  "review",
			"AO_OUTPUT": folder.OutputPath(&stage),
		},
		LogPath: folder.LogPath("review"),
	}
}

// startAgent spawns the stage and returns the executor, its fakes and handle.
func startAgent(t *testing.T, in StartInput) (*AgentExecutor, *fakeSpawner, *fakeSignals, Handle) {
	t.Helper()
	spawner, signals := newFakeSpawner(), &fakeSignals{}
	exec := NewAgentExecutor(spawner, signals)
	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return exec, spawner, signals, h
}

func TestAgentStartSpawnsWithEnvAndPreamble(t *testing.T) {
	in := agentInput(t)
	_, spawner, _, h := startAgent(t, in)

	req := spawner.request()
	if req.ProjectID != "proj-1" {
		t.Errorf("project = %q, want proj-1", req.ProjectID)
	}
	if req.Harness != "claude-code" {
		t.Errorf("harness = %q, want claude-code", req.Harness)
	}
	if req.WorkspacePath != in.WorkspacePath {
		t.Errorf("workspace = %q, want %q", req.WorkspacePath, in.WorkspacePath)
	}
	if got := req.Env["AO_STAGE"]; got != "review" {
		t.Errorf("AO_STAGE = %q, want review", got)
	}
	if got := req.Env["AO_RUN_ID"]; got != "run-1" {
		t.Errorf("AO_RUN_ID = %q, want run-1", got)
	}
	if h.StageID() != "review" || h.RunID() != "run-1" || h.Attempt() != 1 {
		t.Errorf("handle identity = %s/%s/%d, want run-1/review/1", h.RunID(), h.StageID(), h.Attempt())
	}
	if holder, ok := h.(SessionHolder); !ok || holder.SessionID() != "sess-1" {
		t.Errorf("handle does not carry session id sess-1: %#v", h)
	}

	prompt := req.Prompt
	for _, want := range []string{
		"review",
		// Context.md is pasted verbatim, not referenced by path alone.
		"stage `build` finished, its output is at agent-outputs/build.md",
		"$AO_CONTEXT",
		"$AO_OUTPUT",
		"ao pipeline done",
		`ao pipeline fail --reason "..."`,
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if !strings.HasSuffix(prompt, in.Stage.Prompt) {
		t.Errorf("prompt does not end with the stage prompt:\n%s", prompt)
	}
	// v1's findings machinery is deleted and must not come back.
	if strings.Contains(prompt, "findings") {
		t.Errorf("prompt still mentions findings:\n%s", prompt)
	}
}

func TestAgentStartWithoutProducesOmitsOutputPath(t *testing.T) {
	in := agentInput(t)
	in.Stage.Produces = ""
	_, spawner, _, _ := startAgent(t, in)

	if strings.Contains(spawner.request().Prompt, "$AO_OUTPUT") {
		t.Errorf("prompt promises an artifact the stage does not declare:\n%s", spawner.request().Prompt)
	}
}

func TestAgentStartRejectsNonAgentStage(t *testing.T) {
	in := agentInput(t)
	in.Stage.Executor = pipeline.ExecutorCommand
	exec := NewAgentExecutor(newFakeSpawner(), &fakeSignals{})

	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Fatal("Start accepted a command stage")
	}
}

func TestAgentStartRejectsCredentials(t *testing.T) {
	in := agentInput(t)
	in.Credentials = map[string]string{"GH_TOKEN": "secret"}
	spawner := newFakeSpawner()
	exec := NewAgentExecutor(spawner, &fakeSignals{})

	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Fatal("Start injected credentials into an agent session")
	}
	if spawner.spawns != 0 {
		t.Errorf("spawns = %d, want 0", spawner.spawns)
	}
}

func TestAgentPollRunningWhileActiveAndUnsignalled(t *testing.T) {
	exec, _, _, h := startAgent(t, agentInput(t))

	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollRunning {
		t.Errorf("state = %q, want %q", got.State, PollRunning)
	}
}

func TestAgentPollSignaledDoneBeatsIdle(t *testing.T) {
	exec, spawner, signals, h := startAgent(t, agentInput(t))
	// An agent that signalled and then went idle has settled: the signal wins.
	spawner.activity(domain.ActivityIdle, true)
	signals.set(pipeline.SignalDone, "", time.Now())

	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollSignaledDone {
		t.Errorf("state = %q, want %q", got.State, PollSignaledDone)
	}
}

func TestAgentPollSignaledFailBeatsGoneAndCarriesReason(t *testing.T) {
	exec, spawner, signals, h := startAgent(t, agentInput(t))
	spawner.activity(domain.ActivityExited, false)
	signals.set(pipeline.SignalFail, "the migration cannot be written", time.Now())

	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollSignaledFail {
		t.Errorf("state = %q, want %q", got.State, PollSignaledFail)
	}
	if got.Reason != "the migration cannot be written" {
		t.Errorf("reason = %q, want the fail signal's reason", got.Reason)
	}
}

func TestAgentPollSignalReportedOnce(t *testing.T) {
	exec, spawner, signals, h := startAgent(t, agentInput(t))
	spawner.activity(domain.ActivityIdle, true)
	signals.set(pipeline.SignalDone, "", time.Now())

	if got, _ := exec.Poll(context.Background(), h); got.State != PollSignaledDone {
		t.Fatalf("first poll = %q, want %q", got.State, PollSignaledDone)
	}
	// The nudge leaves the same session running against the same signal row.
	// Reporting it twice would settle the stage before the agent could answer.
	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollIdle {
		t.Errorf("second poll = %q, want %q", got.State, PollIdle)
	}

	// A fresh signal after the nudge is reported.
	signals.set(pipeline.SignalDone, "", time.Now().Add(time.Minute))
	if got, _ := exec.Poll(context.Background(), h); got.State != PollSignaledDone {
		t.Errorf("poll after re-signal = %q, want %q", got.State, PollSignaledDone)
	}
}

func TestAgentPollIdleAndGone(t *testing.T) {
	for _, tc := range []struct {
		name     string
		activity domain.ActivityState
		exists   bool
		want     PollState
	}{
		{"idle", domain.ActivityIdle, true, PollIdle},
		{"waiting for input", domain.ActivityWaitingInput, true, PollIdle},
		{"blocked", domain.ActivityBlocked, true, PollIdle},
		{"exited", domain.ActivityExited, true, PollGone},
		{"session vanished", domain.ActivityActive, false, PollGone},
		// An activity state the executor does not know about is not evidence
		// the agent stopped working; the deadline still bounds the stage.
		{"unreported activity", domain.ActivityState(""), true, PollRunning},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exec, spawner, _, h := startAgent(t, agentInput(t))
			spawner.activity(tc.activity, tc.exists)

			got, err := exec.Poll(context.Background(), h)
			if err != nil {
				t.Fatalf("Poll: %v", err)
			}
			if got.State != tc.want {
				t.Errorf("state = %q, want %q", got.State, tc.want)
			}
		})
	}
}

// TestAgentPollIdleBeforeFirstSignalIsStillStarting pins the spawn window. A
// session row is seeded `idle` at spawn and stays there until the harness's
// first hook callback lands, so reading that seed as "the agent stopped" nudges
// and settles the stage seconds after launch, before the agent has read a
// token. Live drill: a real claude-code stage settled no_signal 9s after spawn
// with first_signal_at still NULL.
func TestAgentPollIdleBeforeFirstSignalIsStillStarting(t *testing.T) {
	for _, state := range []domain.ActivityState{domain.ActivityIdle, domain.ActivityWaitingInput, domain.ActivityBlocked} {
		t.Run(string(state), func(t *testing.T) {
			exec, spawner, _, h := startAgent(t, agentInput(t))
			spawner.mu.Lock()
			spawner.snap = SessionSnapshot{Activity: state, Signalled: false}
			spawner.mu.Unlock()

			got, err := exec.Poll(context.Background(), h)
			if err != nil {
				t.Fatalf("Poll: %v", err)
			}
			if got.State != PollRunning {
				t.Errorf("state = %q, want %q: the spawn seed is not an observation", got.State, PollRunning)
			}
		})
	}
}

// TestAgentPollGoneBeforeFirstSignal keeps the exit path unconditional: a
// session that ended during its spawn window is gone whether or not a hook ever
// reported, and waiting for the deadline there would be a lie.
func TestAgentPollGoneBeforeFirstSignal(t *testing.T) {
	exec, spawner, _, h := startAgent(t, agentInput(t))
	spawner.mu.Lock()
	spawner.snap = SessionSnapshot{Activity: domain.ActivityExited, Signalled: false}
	spawner.mu.Unlock()

	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollGone {
		t.Errorf("state = %q, want %q", got.State, PollGone)
	}
}

func TestAgentPollTerminatedSessionIsGone(t *testing.T) {
	exec, spawner, _, h := startAgent(t, agentInput(t))
	spawner.mu.Lock()
	spawner.snap = SessionSnapshot{Activity: domain.ActivityIdle, Terminated: true}
	spawner.mu.Unlock()

	got, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != PollGone {
		t.Errorf("state = %q, want %q", got.State, PollGone)
	}
}

func TestAgentPollPropagatesLookupError(t *testing.T) {
	exec, spawner, _, h := startAgent(t, agentInput(t))
	spawner.mu.Lock()
	spawner.getErr = errors.New("boom")
	spawner.mu.Unlock()

	if _, err := exec.Poll(context.Background(), h); err == nil {
		t.Fatal("Poll swallowed the lookup error")
	}
}

func TestAgentInterruptKeepsTheSession(t *testing.T) {
	exec, spawner, _, h := startAgent(t, agentInput(t))

	if err := exec.Interrupt(context.Background(), h); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	kills, interrupts := spawner.counts()
	if interrupts != 1 {
		t.Errorf("interrupts = %d, want 1", interrupts)
	}
	// timed_out keeps the session record: a human wants the scrollback.
	if kills != 0 {
		t.Errorf("kills = %d, want 0: Interrupt must not kill the session", kills)
	}
}

func TestAgentCancelKillsTheSession(t *testing.T) {
	exec, spawner, _, h := startAgent(t, agentInput(t))

	if err := exec.Cancel(context.Background(), h); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	kills, interrupts := spawner.counts()
	if kills != 1 {
		t.Errorf("kills = %d, want 1", kills)
	}
	if interrupts != 0 {
		t.Errorf("interrupts = %d, want 0", interrupts)
	}
	// Cancel is idempotent: the reducer can cancel an already settled stage.
	if err := exec.Cancel(context.Background(), h); err != nil {
		t.Fatalf("second Cancel: %v", err)
	}
}
