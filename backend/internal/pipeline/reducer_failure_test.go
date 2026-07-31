package pipeline

import (
	"reflect"
	"testing"
)

// findEffect returns the first effect of the requested type.
func findEffect[T Effect](effects []Effect) (T, bool) {
	for _, e := range effects {
		if t, ok := e.(T); ok {
			return t, true
		}
	}
	var zero T
	return zero, false
}

// failStage settles an agent stage through an explicit `ao pipeline fail`.
func failStage(run RunState, stage, reason string, now int) (RunState, []Effect) {
	return Reduce(run, AgentSignaled{Stage: stage, Done: false, Reason: reason, Now: at(now)})
}

const explicitFailureYAML = `
name: explicit-failure
stages:
  - id: build
    executor: command
    run: make
    on_success: ship
    on_failure: diagnose
  - id: ship
    executor: command
    run: ship
  - id: diagnose
    executor: agent
    agent: claude-code
    produces: diagnosis.md
    prompt: why did it fail
`

const defaultFailureYAML = `
name: default-failure
defaults:
  on_failure: notify
stages:
  - id: build
    executor: command
    run: make
    on_success: ship
  - id: ship
    executor: command
    run: ship
  - id: notify
    executor: command
    run: echo notify
`

const twoBuildsYAML = `
name: two-builds
stages:
  - id: fan
    executor: command
    run: echo fan
    on_success: [build-a, build-b]
  - id: build-a
    executor: command
    run: make a
    on_failure: diagnose
  - id: build-b
    executor: command
    run: make b
    on_failure: diagnose
  - id: diagnose
    executor: agent
    agent: claude-code
    produces: diagnosis.md
    prompt: diagnose $AO_FAILED_STAGE
`

func TestReduce_CommandExitNonZeroSettlesFailedAndTakesTheFailureEdge(t *testing.T) {
	run, _ := fire(t, explicitFailureYAML)
	run = launch(run, "build", at(1))

	run, effects := exit(run, "build", 2, at(2))

	if got := outcomeOf(t, run, "build"); got != OutcomeFailed {
		t.Errorf("build = %q, want failed: a non-zero exit is the whole outcome", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"diagnose"}) {
		t.Fatalf("started %v, want [diagnose]", got)
	}
	st := run.Stages["diagnose"]
	if st.EnteredVia != EntryFailure {
		t.Errorf("diagnose entered via %q, want failure", st.EnteredVia)
	}
	if st.FailedStage != "build" || st.FailedOutcome != OutcomeFailed {
		t.Errorf("diagnose failed-stage = %q/%q, want build/failed", st.FailedStage, st.FailedOutcome)
	}
	if st.PrevStage != "" {
		t.Errorf("diagnose prev = %q, want empty: AO_PREV_* names the success predecessor", st.PrevStage)
	}
	if st.WorkspaceKind != WorkspaceInherit {
		t.Errorf("diagnose workspace = %q, want inherit: it resolves at launch to the failed stage's tree", st.WorkspaceKind)
	}
	if got := outcomeOf(t, run, "ship"); got != OutcomeSkipped {
		t.Errorf("ship = %q, want skipped: its predecessor did not succeed", got)
	}
	if countEffect[RunSettled](effects) != 0 {
		t.Errorf("run settled while diagnose was still to run: %v", effects)
	}
}

func TestReduce_ExplicitFailSettlesFailedWithTheStatedReason(t *testing.T) {
	const src = `
name: agent-fails
stages:
  - id: work
    executor: agent
    agent: claude-code
    prompt: do it
    on_failure: notify
  - id: notify
    executor: command
    run: echo notify
`
	run, _ := fire(t, src)
	run = launch(run, "work", at(1))

	run, effects := failStage(run, "work", "the task is impossible", 2)

	if got := outcomeOf(t, run, "work"); got != OutcomeFailed {
		t.Errorf("work = %q, want failed", got)
	}
	if got := run.Stages["work"].Reason; got != "the task is impossible" {
		t.Errorf("reason = %q, want the agent's stated reason", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"notify"}) {
		t.Errorf("started %v, want [notify]", got)
	}
}

func TestReduce_FailureFallsBackToTheDefaultTarget(t *testing.T) {
	run, _ := fire(t, defaultFailureYAML)
	run = launch(run, "build", at(1))

	run, effects := exit(run, "build", 1, at(2))

	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"notify"}) {
		t.Fatalf("started %v, want [notify] from defaults.on_failure", got)
	}
	if got := run.Stages["notify"].FailedStage; got != "build" {
		t.Errorf("notify failed-stage = %q, want build", got)
	}
}

func TestReduce_DefaultTargetsOwnFailureEndsTheBranch(t *testing.T) {
	// The spec section 9.4 carve-out: the stage named by defaults.on_failure does
	// not inherit the default, because routing to itself would be a self-edge.
	run, _ := fire(t, defaultFailureYAML)
	run = launch(run, "build", at(1))
	run, _ = exit(run, "build", 1, at(2))
	run = launch(run, "notify", at(3))

	run, effects := exit(run, "notify", 1, at(4))

	if got := outcomeOf(t, run, "notify"); got != OutcomeFailed {
		t.Errorf("notify = %q, want failed", got)
	}
	if got := startedStages(effects); len(got) != 0 {
		t.Errorf("started %v, want nothing: the default target does not route into itself", got)
	}
	if got := settledStatus(t, effects); got != RunFailed {
		t.Errorf("run settled %q, want failed", got)
	}
}

func TestReduce_FailureRoutingIsFirstArrivalWins(t *testing.T) {
	run, _ := fire(t, twoBuildsYAML)
	run = launch(run, "fan", at(1))
	run, _ = exit(run, "fan", 0, at(2))
	run = launch(run, "build-a", at(3))
	run = launch(run, "build-b", at(3))

	run, effects := exit(run, "build-a", 1, at(4))
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"diagnose"}) {
		t.Fatalf("started %v on the first failure, want [diagnose]", got)
	}

	run, effects = exit(run, "build-b", 1, at(5))
	if got := startedStages(effects); len(got) != 0 {
		t.Errorf("started %v on the second failure, want nothing: later arrivals are dropped", got)
	}
	st := run.Stages["diagnose"]
	if st.Attempt != 1 {
		t.Errorf("diagnose attempt = %d, want 1: it runs exactly once", st.Attempt)
	}
	if st.FailedStage != "build-a" {
		t.Errorf("diagnose failed-stage = %q, want build-a: the first arrival owns the entry", st.FailedStage)
	}
}

func TestReduce_FailureWithNoRouteEndsTheBranch(t *testing.T) {
	run, _ := fire(t, linearYAML)
	run = launch(run, "a", at(1))

	run, effects := exit(run, "a", 1, at(2))

	if got := startedStages(effects); len(got) != 0 {
		t.Errorf("started %v, want nothing: no on_failure and no default means the branch ends", got)
	}
	if got := outcomeOf(t, run, "b"); got != OutcomeSkipped {
		t.Errorf("b = %q, want skipped", got)
	}
	if got := settledStatus(t, effects); got != RunFailed {
		t.Errorf("run settled %q, want failed", got)
	}
}

func TestReduce_StageLaunchFailedSettlesFailedAndRoutes(t *testing.T) {
	run, _ := fire(t, explicitFailureYAML)

	run, effects := Reduce(run, StageLaunchFailed{Stage: "build", Reason: "workspace could not be created", Now: at(1)})

	if got := outcomeOf(t, run, "build"); got != OutcomeFailed {
		t.Errorf("build = %q, want failed: it never got to run", got)
	}
	if got := run.Stages["build"].Reason; got != "workspace could not be created" {
		t.Errorf("reason = %q, want the driver's stated reason", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"diagnose"}) {
		t.Errorf("started %v, want [diagnose]: a launch failure routes like any other failure", got)
	}
}

func TestReduce_TickSettlesAStagePastItsDeadline(t *testing.T) {
	const src = `
name: slow
stages:
  - id: work
    executor: agent
    agent: claude-code
    prompt: think about it
    deadline: 5m
    on_failure: notify
  - id: notify
    executor: command
    run: echo notify
`
	run, _ := fire(t, src)
	run = launch(run, "work", at(1))

	quiet, effects := Reduce(run, Tick{Now: at(5)})
	if len(effects) != 0 {
		t.Fatalf("effects = %v at t+5, want none: the deadline is at t+6", effects)
	}
	if !reflect.DeepEqual(quiet, run) {
		t.Errorf("state changed on a tick inside the deadline")
	}

	run, effects = Reduce(run, Tick{Now: at(7)})

	if got := outcomeOf(t, run, "work"); got != OutcomeTimedOut {
		t.Errorf("work = %q, want timed_out", got)
	}
	if _, ok := findEffect[InterruptStage](effects); !ok {
		t.Errorf("effects = %v, want an InterruptStage: a timed-out agent may still be running", effects)
	}
	settle, ok := findEffect[SettleSession](effects)
	if !ok || settle.Outcome != OutcomeTimedOut || settle.SessionID != "sess-work" {
		t.Errorf("SettleSession = %+v (found %v), want work/sess-work/timed_out", settle, ok)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"notify"}) {
		t.Errorf("started %v, want [notify]: a timeout routes to failure", got)
	}
}

func TestReduce_TickIgnoresStagesThatAreNotRunning(t *testing.T) {
	run, _ := fire(t, linearYAML)

	next, effects := Reduce(run, Tick{Now: at(9999)})

	if len(effects) != 0 {
		t.Errorf("effects = %v, want none: a pending stage has no deadline yet", effects)
	}
	if !reflect.DeepEqual(next, run) {
		t.Errorf("state changed on a tick with nothing running")
	}
}

func TestReduce_CancelSettlesEverythingAndRoutesNowhere(t *testing.T) {
	run, _ := fire(t, defaultFailureYAML)
	run = launch(run, "build", at(1))

	run, effects := Reduce(run, CancelRequested{Reason: "superseded", Now: at(2)})

	if got := outcomeOf(t, run, "build"); got != OutcomeCancelled {
		t.Errorf("build = %q, want cancelled: a running stage is torn down", got)
	}
	if got := outcomeOf(t, run, "ship"); got != OutcomeSkipped {
		t.Errorf("ship = %q, want skipped: a pending stage never ran", got)
	}
	if got := outcomeOf(t, run, "notify"); got != OutcomeSkipped {
		t.Errorf("notify = %q, want skipped, not entered: a cancelled stage does not route to on_failure", got)
	}
	if got := startedStages(effects); len(got) != 0 {
		t.Errorf("started %v, want nothing: the run is being torn down, not routed", got)
	}
	cancel, ok := findEffect[CancelStageExec](effects)
	if !ok || cancel.Stage != "build" {
		t.Errorf("CancelStageExec = %+v (found %v), want build", cancel, ok)
	}
	if countEffect[CancelStageExec](effects) != 1 {
		t.Errorf("effects = %v, want exactly one CancelStageExec: only build was running", effects)
	}
	if got := settledStatus(t, effects); got != RunCancelled {
		t.Errorf("run settled %q, want cancelled", got)
	}
	if run.CancelReason != "superseded" {
		t.Errorf("cancel reason = %q, want superseded", run.CancelReason)
	}
	if !run.SettledAt.Equal(at(2)) {
		t.Errorf("settled at %v, want %v", run.SettledAt, at(2))
	}
}

func TestReduce_CancelOfAnAgentStageHandsTheSessionToTheDriver(t *testing.T) {
	const src = `
name: agent-cancel
stages:
  - id: work
    executor: agent
    agent: claude-code
    prompt: do it
`
	run, _ := fire(t, src)
	run = launch(run, "work", at(1))

	_, effects := Reduce(run, CancelRequested{Reason: "killed", Now: at(2)})

	settle, ok := findEffect[SettleSession](effects)
	if !ok || settle.Outcome != OutcomeCancelled || settle.SessionID != "sess-work" {
		t.Errorf("SettleSession = %+v (found %v), want work/sess-work/cancelled", settle, ok)
	}
}

func TestReduce_AgentSettlementHandsTheSessionToTheDriver(t *testing.T) {
	const src = `
name: dispositions
stages:
  - id: review
    executor: agent
    agent: claude-code
    produces: review.md
    prompt: review it
`
	run, _ := fire(t, src)
	run = launch(run, "review", at(1))

	_, effects := Reduce(run, AgentSignaled{Stage: "review", Done: true, ArtifactOK: true, Now: at(2)})

	settle, ok := findEffect[SettleSession](effects)
	if !ok || settle.Stage != "review" || settle.SessionID != "sess-review" || settle.Outcome != OutcomeSucceeded {
		t.Errorf("SettleSession = %+v (found %v), want review/sess-review/succeeded", settle, ok)
	}
}

func TestReduce_CommandSettlementHasNoSessionDisposition(t *testing.T) {
	run, _ := fire(t, linearYAML)
	run = launch(run, "a", at(1))

	_, effects := exit(run, "a", 1, at(2))

	if countEffect[SettleSession](effects) != 0 {
		t.Errorf("effects = %v, want no SettleSession: a command stage has no session to dispose of", effects)
	}
}

func TestReduce_FailureRoutingDoesNotMutateInput(t *testing.T) {
	run, _ := fire(t, twoBuildsYAML)
	before, _ := fire(t, twoBuildsYAML)
	for _, mutate := range []func(RunState) RunState{
		func(r RunState) RunState { return launch(r, "fan", at(1)) },
		func(r RunState) RunState { next, _ := exit(r, "fan", 0, at(2)); return next },
		func(r RunState) RunState { return launch(r, "build-a", at(3)) },
		func(r RunState) RunState { return launch(r, "build-b", at(3)) },
	} {
		run = mutate(run)
		before = mutate(before)
	}
	if !reflect.DeepEqual(run, before) {
		t.Fatalf("fixtures diverged before the call under test")
	}

	Reduce(run, CommandExited{Stage: "build-a", ExitCode: 1, Now: at(4)})

	if !reflect.DeepEqual(run, before) {
		t.Errorf("Reduce mutated its input:\n got %+v\nwant %+v", run, before)
	}
}
