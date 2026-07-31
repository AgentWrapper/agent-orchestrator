package pipeline

import (
	"reflect"
	"testing"
)

const producesYAML = `
name: verified-agent
stages:
  - id: review
    executor: agent
    agent: claude-code
    produces: review.md
    prompt: review it
    on_failure: notify
  - id: notify
    executor: command
    run: echo notify
`

const noProducesYAML = `
name: unverified-agent
stages:
  - id: work
    executor: agent
    agent: claude-code
    prompt: do the thing
    on_failure: notify
  - id: notify
    executor: command
    run: echo notify
`

// signalDone settles an agent stage through `ao pipeline done`, carrying the
// driver's verification of the declared artifact.
func signalDone(run RunState, stage string, artifactOK bool, now int) (RunState, []Effect) {
	return Reduce(run, AgentSignaled{Stage: stage, Done: true, ArtifactOK: artifactOK, Now: at(now)})
}

func idle(run RunState, stage string, artifactOK bool, now int) (RunState, []Effect) {
	return Reduce(run, SessionIdle{Stage: stage, ArtifactOK: artifactOK, Now: at(now)})
}

func nudgeMessages(effects []Effect) []string {
	out := make([]string, 0, len(effects))
	for _, e := range effects {
		if n, ok := e.(NudgeStage); ok {
			out = append(out, n.Message)
		}
	}
	return out
}

// runningAgent fires a one-agent pipeline and gets its stage running.
func runningAgent(t *testing.T, src, stage string) RunState {
	t.Helper()
	run, _ := fire(t, src)
	return launch(run, stage, at(1))
}

func TestReduce_DoneWithAMissingArtifactNudgesOnceThenSettlesNoOutput(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")

	run, effects := signalDone(run, "review", false, 2)

	if got := outcomeOf(t, run, "review"); got != OutcomeRunning {
		t.Fatalf("review = %q, want running: the nudge never leaves the stage", got)
	}
	nudge, ok := findEffect[NudgeStage](effects)
	if !ok || nudge.Stage != "review" || nudge.SessionID != "sess-review" {
		t.Fatalf("NudgeStage = %+v (found %v), want review/sess-review", nudge, ok)
	}
	if !run.Nudged["review"] {
		t.Errorf("Nudged[review] = false, want true: one nudge, two attempts total")
	}
	if got := run.Stages["review"].Attempt; got != 1 {
		t.Errorf("attempt = %d, want 1: it becomes 2 only once the nudge is delivered", got)
	}
	if countEffect[SettleSession](effects) != 0 {
		t.Errorf("effects = %v, want no SettleSession: the stage has not settled", effects)
	}

	run, effects = Reduce(run, NudgeDelivered{Stage: "review", Now: at(3)})
	if got := run.Stages["review"].Attempt; got != 2 {
		t.Errorf("attempt = %d after delivery, want 2 (AO_ATTEMPT lets a prompt tell it is being nudged)", got)
	}
	if countEffect[PersistRun](effects) != 1 {
		t.Errorf("effects = %v, want one PersistRun: the attempt count is recorded", effects)
	}

	run, effects = signalDone(run, "review", false, 4)

	if got := outcomeOf(t, run, "review"); got != OutcomeNoOutput {
		t.Errorf("review = %q, want no_output on the second attempt", got)
	}
	if got := nudgeMessages(effects); len(got) != 0 {
		t.Errorf("nudged again with %v, want one nudge per stage, not configurable", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"notify"}) {
		t.Errorf("started %v, want [notify]: no_output routes to failure", got)
	}
}

func TestReduce_NudgeMessageMatchesTheSpecCharacterForCharacter(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")

	_, effects := signalDone(run, "review", false, 2)

	want := "You signaled done but agent-outputs/review.md does not exist or is empty.\n" +
		"Overwrite it now, then signal again."
	if got := nudgeMessages(effects); len(got) != 1 || got[0] != want {
		t.Errorf("nudge = %q, want %q", got, want)
	}
}

func TestReduce_ExplicitFailIsNeverNudged(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")

	run, effects := failStage(run, "review", "cannot be done", 2)

	if got := nudgeMessages(effects); len(got) != 0 {
		t.Errorf("nudged %v, want nothing: the agent decided, respect it", got)
	}
	if got := outcomeOf(t, run, "review"); got != OutcomeFailed {
		t.Errorf("review = %q, want failed", got)
	}
	if run.Nudged["review"] {
		t.Errorf("Nudged[review] = true, want false")
	}
}

func TestReduce_ExitedSessionIsNeverNudged(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")

	run, effects := Reduce(run, SessionGone{Stage: "review", Now: at(2)})

	if got := nudgeMessages(effects); len(got) != 0 {
		t.Errorf("nudged %v, want nothing: there is nothing left to nudge", got)
	}
	if got := outcomeOf(t, run, "review"); got != OutcomeNoSignal {
		t.Errorf("review = %q, want no_signal", got)
	}
	settle, ok := findEffect[SettleSession](effects)
	if !ok || settle.Outcome != OutcomeNoSignal {
		t.Errorf("SettleSession = %+v (found %v), want no_signal", settle, ok)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"notify"}) {
		t.Errorf("started %v, want [notify]: no_signal routes to failure", got)
	}
}

func TestReduce_IdleWithAMissingArtifactNudgesThenSettlesNoOutput(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")

	run, effects := idle(run, "review", false, 2)

	want := "You signaled done but agent-outputs/review.md does not exist or is empty.\n" +
		"Overwrite it now, then signal again."
	if got := nudgeMessages(effects); len(got) != 1 || got[0] != want {
		t.Fatalf("nudge = %q, want %q", got, want)
	}
	if got := outcomeOf(t, run, "review"); got != OutcomeRunning {
		t.Fatalf("review = %q, want running", got)
	}

	run, _ = Reduce(run, NudgeDelivered{Stage: "review", Now: at(3)})
	run, _ = idle(run, "review", false, 4)

	if got := outcomeOf(t, run, "review"); got != OutcomeNoOutput {
		t.Errorf("review = %q, want no_output: the declared artifact is still missing", got)
	}
}

func TestReduce_IdleWithoutAnArtifactContractNudgesForTheSignalThenSettlesNoSignal(t *testing.T) {
	run := runningAgent(t, noProducesYAML, "work")

	run, effects := idle(run, "work", true, 2)

	want := "You appear to be finished but have not signalled. " +
		"Run 'ao pipeline done' or 'ao pipeline fail --reason ...' now."
	if got := nudgeMessages(effects); len(got) != 1 || got[0] != want {
		t.Fatalf("nudge = %q, want %q", got, want)
	}
	if got := outcomeOf(t, run, "work"); got != OutcomeRunning {
		t.Fatalf("work = %q, want running: idle is the disambiguation, not a settlement", got)
	}

	run, effects = idle(run, "work", true, 3)

	if got := outcomeOf(t, run, "work"); got != OutcomeNoSignal {
		t.Errorf("work = %q, want no_signal: it went idle twice without signalling", got)
	}
	if got := startedStages(effects); !reflect.DeepEqual(got, []string{"notify"}) {
		t.Errorf("started %v, want [notify]", got)
	}
}

func TestReduce_IdleWithAVerifiedArtifactStillAsksForTheSignal(t *testing.T) {
	// produces is declared and the file is there, so the missing-artifact text
	// would be a lie: what is missing is the signal.
	run := runningAgent(t, producesYAML, "review")

	run, effects := idle(run, "review", true, 2)

	want := "You appear to be finished but have not signalled. " +
		"Run 'ao pipeline done' or 'ao pipeline fail --reason ...' now."
	if got := nudgeMessages(effects); len(got) != 1 || got[0] != want {
		t.Fatalf("nudge = %q, want %q", got, want)
	}

	run, _ = idle(run, "review", true, 3)
	if got := outcomeOf(t, run, "review"); got != OutcomeNoSignal {
		t.Errorf("review = %q, want no_signal", got)
	}
}

func TestReduce_ANudgedStageCanStillSucceed(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")
	run, _ = signalDone(run, "review", false, 2)
	run, _ = Reduce(run, NudgeDelivered{Stage: "review", Now: at(3)})

	run, effects := signalDone(run, "review", true, 4)

	if got := outcomeOf(t, run, "review"); got != OutcomeSucceeded {
		t.Errorf("review = %q, want succeeded: succeeded after one nudge is the point", got)
	}
	if got := settledStatus(t, effects); got != RunSucceeded {
		t.Errorf("run settled %q, want succeeded", got)
	}
}

func TestReduce_OneNudgePerStageAcrossEventKinds(t *testing.T) {
	// The idle nudge and the done-with-no-artifact nudge share the one budget:
	// if a second nudge would help, the prompt is wrong.
	run := runningAgent(t, producesYAML, "review")
	run, _ = idle(run, "review", false, 2)

	run, effects := signalDone(run, "review", false, 3)

	if got := nudgeMessages(effects); len(got) != 0 {
		t.Errorf("nudged %v, want nothing: the stage already had its one nudge", got)
	}
	if got := outcomeOf(t, run, "review"); got != OutcomeNoOutput {
		t.Errorf("review = %q, want no_output", got)
	}
}

func TestReduce_NudgeDeliveredForAStageThatWasNotNudgedChangesNothing(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")

	next, effects := Reduce(run, NudgeDelivered{Stage: "review", Now: at(2)})

	if len(effects) != 0 {
		t.Errorf("effects = %v, want none", effects)
	}
	if !reflect.DeepEqual(next, run) {
		t.Errorf("state changed on a delivery for a nudge that was never sent")
	}
}

func TestReduce_NudgeDoesNotMutateInput(t *testing.T) {
	run := runningAgent(t, producesYAML, "review")
	before := runningAgent(t, producesYAML, "review")
	if !reflect.DeepEqual(run, before) {
		t.Fatalf("fixtures diverged before the call under test")
	}

	Reduce(run, SessionIdle{Stage: "review", ArtifactOK: false, Now: at(2)})

	if !reflect.DeepEqual(run, before) {
		t.Errorf("Reduce mutated its input:\n got %+v\nwant %+v", run, before)
	}
}
