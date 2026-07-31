package pipeline

import (
	"reflect"
	"testing"
	"time"
)

// reducerT0 anchors every reducer test on a fixed clock. The reducer never
// reads the clock itself: every event carries a driver-stamped Now, which is
// what makes the whole thing testable without a fake clock.
var reducerT0 = time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)

func at(minutes int) time.Time { return reducerT0.Add(time.Duration(minutes) * time.Minute) }

func sessionSubject() Subject {
	return Subject{Kind: SubjectSession, ProjectID: "proj", SessionID: "sess-1"}
}

// fire builds a run from YAML and reduces the TriggerFired that starts it.
func fire(t *testing.T, src string) (RunState, []Effect) {
	t.Helper()
	def := mustParse(t, []byte(src))
	return Reduce(RunState{PipelineID: "pl-1"}, TriggerFired{
		Def:     *def,
		Subject: sessionSubject(),
		RunID:   "run-1",
		RunDir:  "/runs/run-1",
		Now:     reducerT0,
	})
}

// launch runs a stage through the pending-to-running transition.
func launch(run RunState, stage string, now time.Time) RunState {
	next, _ := Reduce(run, StageLaunched{Stage: stage, SessionID: "sess-" + stage, WorkspacePath: "/w/" + stage, Now: now})
	return next
}

// exit settles a command stage on its exit code.
func exit(run RunState, stage string, code int, now time.Time) (RunState, []Effect) {
	return Reduce(run, CommandExited{Stage: stage, ExitCode: code, Now: now})
}

func startedStages(effects []Effect) []string {
	out := make([]string, 0, len(effects))
	for _, e := range effects {
		if s, ok := e.(StartStage); ok {
			out = append(out, s.Stage)
		}
	}
	return out
}

func contextLines(effects []Effect) []string {
	out := make([]string, 0, len(effects))
	for _, e := range effects {
		if c, ok := e.(AppendContext); ok {
			out = append(out, c.Line)
		}
	}
	return out
}

func countEffect[T Effect](effects []Effect) int {
	n := 0
	for _, e := range effects {
		if _, ok := e.(T); ok {
			n++
		}
	}
	return n
}

func settledStatus(t *testing.T, effects []Effect) RunStatus {
	t.Helper()
	for _, e := range effects {
		if s, ok := e.(RunSettled); ok {
			return s.Status
		}
	}
	t.Fatalf("no RunSettled effect in %v", effects)
	return ""
}

func outcomeOf(t *testing.T, run RunState, stage string) Outcome {
	t.Helper()
	st, ok := run.Stages[stage]
	if !ok {
		t.Fatalf("stage %q not in run (have %v)", stage, stageIDsOf(run))
	}
	return st.Outcome
}

func stageIDsOf(run RunState) []string {
	out := make([]string, 0, len(run.Stages))
	for id := range run.Stages {
		out = append(out, id)
	}
	return out
}

const linearYAML = `
name: linear
stages:
  - id: a
    executor: command
    run: echo a
    on_success: b
  - id: b
    executor: command
    run: echo b
`

const fanOutYAML = `
name: fan-out
stages:
  - id: a
    executor: command
    run: echo a
    on_success: [b, c, d]
  - id: b
    executor: command
    run: echo b
  - id: c
    executor: command
    run: echo c
  - id: d
    executor: command
    run: echo d
`

const joinYAML = `
name: join
stages:
  - id: a
    executor: command
    run: echo a
    on_success: [b, c]
  - id: b
    executor: command
    run: echo b
    on_success: j
  - id: c
    executor: command
    run: echo c
    on_success: j
  - id: j
    executor: command
    run: echo j
    needs: [b, c]
    on_success: k
  - id: k
    executor: command
    run: echo k
`

func TestReduce_TriggerSeedsReachableStagesAndStartsEntry(t *testing.T) {
	run, effects := fire(t, linearYAML)

	if run.RunID != "run-1" || run.RunDir != "/runs/run-1" {
		t.Errorf("run identity = %q %q, want run-1 /runs/run-1", run.RunID, run.RunDir)
	}
	if run.PipelineName != "linear" {
		t.Errorf("pipeline name = %q, want linear", run.PipelineName)
	}
	if run.ProjectID != "proj" {
		t.Errorf("project = %q, want proj (from the subject)", run.ProjectID)
	}
	if run.Status != RunRunning {
		t.Errorf("status = %q, want running", run.Status)
	}
	if len(run.Stages) != 2 {
		t.Fatalf("seeded %d stages, want 2", len(run.Stages))
	}
	if got := outcomeOf(t, run, "b"); got != OutcomePending {
		t.Errorf("b = %q, want pending: every reachable stage is seeded so the board renders it", got)
	}
	if got := run.Stages["a"].EnteredVia; got != EntryTrigger {
		t.Errorf("a entered via %q, want trigger", got)
	}
	if got := run.Stages["a"].Attempt; got != 1 {
		t.Errorf("a attempt = %d, want 1", got)
	}
	if got := run.Stages["a"].WorkspaceKind; got != WorkspaceSession {
		t.Errorf("a workspace = %q, want session (auto under a session subject)", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"a"}) {
		t.Errorf("started %v, want [a] only", got)
	}
	if countEffect[PersistRun](effects) != 1 {
		t.Errorf("effects = %v, want exactly one PersistRun", effects)
	}
}

func TestReduce_LinearHappyPath(t *testing.T) {
	run, _ := fire(t, linearYAML)

	run = launch(run, "a", at(1))
	if got := outcomeOf(t, run, "a"); got != OutcomeRunning {
		t.Fatalf("a = %q, want running", got)
	}
	if got, want := run.Stages["a"].DeadlineAt, at(1).Add(DefaultStageDeadline); !got.Equal(want) {
		t.Errorf("a deadline = %v, want %v", got, want)
	}

	run, effects := exit(run, "a", 0, at(2))
	if got := outcomeOf(t, run, "a"); got != OutcomeSucceeded {
		t.Errorf("a = %q, want succeeded", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("started %v, want [b]", got)
	}
	if got := run.Stages["b"].EnteredVia; got != EntrySuccess {
		t.Errorf("b entered via %q, want success", got)
	}
	if got := run.Stages["b"].PrevStage; got != "a" {
		t.Errorf("b prev = %q, want a", got)
	}
	if countEffect[RunSettled](effects) != 0 {
		t.Errorf("run settled while b was still to run: %v", effects)
	}

	run = launch(run, "b", at(3))
	run, effects = exit(run, "b", 0, at(4))
	if got := outcomeOf(t, run, "b"); got != OutcomeSucceeded {
		t.Errorf("b = %q, want succeeded", got)
	}
	if got := settledStatus(t, effects); got != RunSucceeded {
		t.Errorf("run settled %q, want succeeded", got)
	}
	if run.Status != RunSucceeded || !run.SettledAt.Equal(at(4)) {
		t.Errorf("run = %q settled %v, want succeeded at %v", run.Status, run.SettledAt, at(4))
	}
	if countEffect[StartStage](effects) != 0 {
		t.Errorf("absent on_success ends the branch, got %v", effects)
	}
}

func TestReduce_FanOutStartsEveryTargetInOneReduction(t *testing.T) {
	run, _ := fire(t, fanOutYAML)
	run = launch(run, "a", at(1))

	_, effects := exit(run, "a", 0, at(2))

	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"b", "c", "d"}) {
		t.Errorf("started %v, want [b c d] in declaration order from one reduction", got)
	}
}

func TestReduce_JoinWaitsForEveryNeed(t *testing.T) {
	run, _ := fire(t, joinYAML)
	run = launch(run, "a", at(1))
	run, _ = exit(run, "a", 0, at(2))
	run = launch(run, "b", at(3))
	run = launch(run, "c", at(3))

	run, effects := exit(run, "b", 0, at(4))
	if got := startedStages(effects); len(got) != 0 {
		t.Fatalf("started %v on the first need, want nothing until every need succeeds", got)
	}
	if got := outcomeOf(t, run, "j"); got != OutcomePending {
		t.Errorf("j = %q, want pending", got)
	}

	run, effects = exit(run, "c", 0, at(5))
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"j"}) {
		t.Fatalf("started %v on the last need, want [j] exactly once", got)
	}
	if got := run.Stages["j"].PrevStage; got != "" {
		t.Errorf("j prev = %q, want empty: a join has no sole predecessor", got)
	}
}

func TestReduce_JoinCascadeSkipsWhenANeedDoesNotSucceed(t *testing.T) {
	run, _ := fire(t, joinYAML)
	run = launch(run, "a", at(1))
	run, _ = exit(run, "a", 0, at(2))
	run = launch(run, "b", at(3))
	run = launch(run, "c", at(3))

	// c settles failed with nothing routing anywhere (this pipeline declares no
	// on_failure and no defaults.on_failure). Failure settlement itself is the
	// next task's; what is under test here is the cascade it leaves behind.
	run.Stages["c"].Outcome = OutcomeFailed
	run.Stages["c"].SettledAt = at(4)

	run, effects := exit(run, "b", 0, at(5))

	if got := outcomeOf(t, run, "j"); got != OutcomeSkipped {
		t.Errorf("j = %q, want skipped: a join whose need did not succeed is skipped, not failed", got)
	}
	if got := outcomeOf(t, run, "k"); got != OutcomeSkipped {
		t.Errorf("k = %q, want skipped: the skip cascades", got)
	}
	if got := settledStatus(t, effects); got != RunFailed {
		t.Errorf("run settled %q, want failed: a stage settled failed", got)
	}
}

func TestReduce_UnreachedFailurePathIsSkippedSoTheRunSettles(t *testing.T) {
	const src = `
name: with-failure-route
defaults:
  on_failure: notify
stages:
  - id: a
    executor: command
    run: echo a
  - id: notify
    executor: command
    run: echo notify
`
	run, _ := fire(t, src)
	if got := outcomeOf(t, run, "notify"); got != OutcomePending {
		t.Fatalf("notify = %q, want pending while a could still fail into it", got)
	}

	run = launch(run, "a", at(1))
	run, effects := exit(run, "a", 0, at(2))

	if got := outcomeOf(t, run, "notify"); got != OutcomeSkipped {
		t.Errorf("notify = %q, want skipped once nothing can route into it", got)
	}
	if got := settledStatus(t, effects); got != RunSucceeded {
		t.Errorf("run settled %q, want succeeded: skipped is not failed", got)
	}
}

func TestReduce_AgentSucceedsUnverifiedWithoutProduces(t *testing.T) {
	const src = `
name: unverified
stages:
  - id: solo
    executor: agent
    agent: claude-code
    prompt: do the thing
`
	run, _ := fire(t, src)
	run = launch(run, "solo", at(1))

	run, effects := Reduce(run, AgentSignaled{Stage: "solo", Done: true, ArtifactOK: true, Now: at(2)})

	if got := outcomeOf(t, run, "solo"); got != OutcomeSucceededUnverified {
		t.Errorf("solo = %q, want succeeded_unverified: nothing was declared, so nothing was verified", got)
	}
	if got := contextLines(effects); len(got) != 0 {
		t.Errorf("appended %v to Context.md, want nothing: there is no artifact to point at", got)
	}
	if got := settledStatus(t, effects); got != RunSucceeded {
		t.Errorf("run settled %q, want succeeded", got)
	}
}

func TestReduce_AgentSucceedsAndPointsContextAtItsArtifact(t *testing.T) {
	const src = `
name: verified
stages:
  - id: review
    executor: agent
    agent: claude-code
    produces: review.md
    prompt: review it
`
	run, _ := fire(t, src)
	run = launch(run, "review", at(1))

	run, effects := Reduce(run, AgentSignaled{Stage: "review", Done: true, ArtifactOK: true, Now: at(2)})

	if got := outcomeOf(t, run, "review"); got != OutcomeSucceeded {
		t.Errorf("review = %q, want succeeded", got)
	}
	want := "stage `review` finished, its output is at agent-outputs/review.md"
	if got := contextLines(effects); len(got) != 1 || got[0] != want {
		t.Errorf("context lines = %v, want [%q]", got, want)
	}
}

func TestReduce_CommandExitZeroSucceedsWithoutAContextLine(t *testing.T) {
	run, _ := fire(t, linearYAML)
	run = launch(run, "a", at(1))

	_, effects := exit(run, "a", 0, at(2))

	if got := contextLines(effects); len(got) != 0 {
		t.Errorf("appended %v, want nothing: a command stage declares no artifact", got)
	}
}

func TestReduceDoesNotMutateInput(t *testing.T) {
	// Two independently allocated fixtures of the same run: one to reduce, one
	// to compare against. Purity is load-bearing, because the engine keeps the
	// pre-reduce state around until the effects are walked.
	run, _ := fire(t, joinYAML)
	before, _ := fire(t, joinYAML)
	run = launch(run, "a", at(1))
	before = launch(before, "a", at(1))

	if !reflect.DeepEqual(run, before) {
		t.Fatalf("fixtures diverged before the call under test")
	}

	Reduce(run, CommandExited{Stage: "a", ExitCode: 0, Now: at(2)})

	if !reflect.DeepEqual(run, before) {
		t.Errorf("Reduce mutated its input:\n got %+v\nwant %+v", run, before)
	}
}

func TestReduce_IgnoresEventsForAStageThatIsNotRunning(t *testing.T) {
	run, _ := fire(t, linearYAML)

	next, effects := exit(run, "b", 0, at(2))

	if len(effects) != 0 {
		t.Errorf("effects = %v, want none: b never started", effects)
	}
	if !reflect.DeepEqual(next, run) {
		t.Errorf("state changed on an event for a stage that never started")
	}
}

func TestReduce_IgnoresEventsAfterTheRunSettles(t *testing.T) {
	run, _ := fire(t, linearYAML)
	run = launch(run, "a", at(1))
	run, _ = exit(run, "a", 0, at(2))
	run = launch(run, "b", at(3))
	run, _ = exit(run, "b", 0, at(4))

	next, effects := Reduce(run, CommandExited{Stage: "b", ExitCode: 1, Now: at(5)})

	if len(effects) != 0 {
		t.Errorf("effects = %v, want none after the run settled", effects)
	}
	if !reflect.DeepEqual(next, run) {
		t.Errorf("state changed after the run settled")
	}
}

func TestReduce_PlanFailureSettlesTheRunWithTheReasonStated(t *testing.T) {
	const src = `
name: needs-a-session
on:
  pr: [created]
stages:
  - id: review
    executor: agent
    agent: claude-code
    prompt: review it
    workspace: session
`
	def := mustParse(t, []byte(src))
	run, effects := Reduce(RunState{PipelineID: "pl-1"}, TriggerFired{
		Def:     *def,
		Subject: prSubject(412),
		RunID:   "run-1",
		RunDir:  "/runs/run-1",
		Now:     reducerT0,
	})

	if got := settledStatus(t, effects); got != RunFailed {
		t.Fatalf("run settled %q, want failed", got)
	}
	if got := outcomeOf(t, run, "review"); got != OutcomeFailed {
		t.Errorf("review = %q, want failed", got)
	}
	want := "stage 'review' requires workspace 'session'; PR #412 has no local session"
	if got := run.Stages["review"].Reason; got != want {
		t.Errorf("reason = %q, want %q", got, want)
	}
}
