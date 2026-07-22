package pipeline

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

// observationsNamed returns every EMIT_OBSERVATION effect with the given name.
func observationsNamed(effects []Effect, name string) []EmitObservation {
	var out []EmitObservation
	for _, e := range effects {
		if o, ok := e.(EmitObservation); ok && o.Name == name {
			out = append(out, o)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Deadlines (STAGE_STARTED stamps, TICK enforces)
// ---------------------------------------------------------------------------

func TestStageStartedStampsDeadline(t *testing.T) {
	t.Run("default deadline applies when TimeoutMs is unset", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, nil)
		state, _ := Reduce(engineWith(run), StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		got := state.Runs["r1"].Stages["a"].Deadline
		if got == nil {
			t.Fatal("deadline should be stamped on STAGE_STARTED")
		}
		if want := testNow.Add(DefaultStageTimeout); !got.Equal(want) {
			t.Fatalf("deadline = %v, want %v (started + DefaultStageTimeout)", got, want)
		}
	})

	t.Run("configured TimeoutMs overrides the default", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.Stages[0].TimeoutMs = int64Ptr(5000)
		run := runState("r1", p, nil)
		state, _ := Reduce(engineWith(run), StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		got := state.Runs["r1"].Stages["a"].Deadline
		if want := testNow.Add(5 * time.Second); got == nil || !got.Equal(want) {
			t.Fatalf("deadline = %v, want %v", got, want)
		}
	})
}

func TestReduceTickDeadline(t *testing.T) {
	t.Run("wedged running stage past its deadline fails via Tick and the run proceeds", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		run := runState("r1", p, nil)
		state := wedgeStage(engineWith(run), "r1", "a", testNow.Add(-time.Minute))

		state, effects := Reduce(state, Tick{Now: testNow})
		final := state.Runs["r1"]
		if final.Stages["a"].Status != StageStatusFailed {
			t.Fatalf("stage a = %v, want failed", final.Stages["a"].Status)
		}
		if final.Stages["b"].Status != StageStatusSkipped {
			t.Fatalf("stage b = %v, want cascade-skipped", final.Stages["b"].Status)
		}
		if final.LoopState != LoopStalled {
			t.Fatalf("run loopState = %v, want stalled", final.LoopState)
		}
		if !strings.Contains(final.Stages["a"].ErrorMessage, "timed out") {
			t.Fatalf("stage a error = %q, want a timeout message", final.Stages["a"].ErrorMessage)
		}
		// The engine must tear the still-live executor handle down.
		if got := len(effectsByType(effects)[EffectCancelStage]); got != 1 {
			t.Fatalf("CANCEL_STAGE count = %d, want 1; effects=%v", got, effects)
		}
	})

	t.Run("running stage before its deadline is untouched", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		future := testNow.Add(time.Minute)
		s := run.Stages["a"]
		s.StartedAt = &testNow
		s.Deadline = &future
		run.Stages["a"] = s

		state, effects := Reduce(engineWith(run), Tick{Now: testNow})
		if len(effects) != 0 {
			t.Fatalf("no effects expected before the deadline, got %v", effects)
		}
		if state.Runs["r1"].Stages["a"].Status != StageStatusRunning {
			t.Fatal("stage a should still be running")
		}
	})

	t.Run("Tick with nothing running is a no-op", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		in := engineWith(runState("r1", p, nil))
		state, effects := Reduce(in, Tick{Now: testNow})
		if len(effects) != 0 {
			t.Fatalf("expected no effects, got %v", effects)
		}
		if !reflect.DeepEqual(state, in) {
			t.Fatal("Tick should not change state when nothing is running")
		}
	})
}

// ---------------------------------------------------------------------------
// Automatic retries
// ---------------------------------------------------------------------------

func TestStageFailedAutoRetry(t *testing.T) {
	t.Run("failed stage auto-retries exactly `retries` times then finalizes", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.Stages[0].Retries = intPtr(2) // 2 retries => up to 3 attempts total.
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		st := engineWith(run)

		// Attempt 1 fails -> re-pend as attempt 2 and start again.
		st, eff := Reduce(st, StageFailed{Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "boom1"})
		a := st.Runs["r1"].Stages["a"]
		if a.Status != StageStatusPending || a.Attempt != 2 {
			t.Fatalf("after fail #1: %v attempt=%d, want pending attempt=2", a.Status, a.Attempt)
		}
		if a.StageRunID != "sr-a#2" {
			t.Fatalf("retry stageRunId = %q, want sr-a#2", a.StageRunID)
		}
		if len(effectsByType(eff)[EffectStartStage]) != 1 {
			t.Fatal("retry should re-start the stage")
		}
		if len(observationsNamed(eff, "pipeline.stage.retried")) != 1 {
			t.Fatal("retry should emit a pipeline.stage.retried observation")
		}
		if st.Runs["r1"].LoopState != LoopRunning {
			t.Fatalf("run should still be running after a retry, got %v", st.Runs["r1"].LoopState)
		}

		// Attempt 2 fails -> re-pend as attempt 3.
		st, _ = Reduce(st, StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		st, _ = Reduce(st, StageFailed{Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "boom2"})
		a = st.Runs["r1"].Stages["a"]
		if a.Status != StageStatusPending || a.Attempt != 3 {
			t.Fatalf("after fail #2: %v attempt=%d, want pending attempt=3", a.Status, a.Attempt)
		}

		// Attempt 3 fails -> retry budget exhausted -> finalize failed/stalled.
		st, _ = Reduce(st, StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		st, _ = Reduce(st, StageFailed{Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "boom3"})
		final := st.Runs["r1"]
		if final.Stages["a"].Status != StageStatusFailed || final.Stages["a"].Attempt != 3 {
			t.Fatalf("final stage = %v attempt=%d, want failed attempt=3", final.Stages["a"].Status, final.Stages["a"].Attempt)
		}
		if final.Stages["a"].ErrorMessage != "boom3" {
			t.Fatalf("final error = %q, want boom3", final.Stages["a"].ErrorMessage)
		}
		if final.LoopState != LoopStalled {
			t.Fatalf("run = %v, want stalled once retries are exhausted", final.LoopState)
		}
	})

	t.Run("timeout failures also consume the retry budget", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.Stages[0].Retries = intPtr(1) // 1 retry => 2 attempts total.
		run := runState("r1", p, nil)
		past := testNow.Add(-time.Minute)
		st := wedgeStage(engineWith(run), "r1", "a", past)

		// First timeout -> retry (attempt 2), cancelling the live handle and restarting.
		st, eff := Reduce(st, Tick{Now: testNow})
		a := st.Runs["r1"].Stages["a"]
		if a.Status != StageStatusPending || a.Attempt != 2 {
			t.Fatalf("after timeout #1: %v attempt=%d, want pending attempt=2", a.Status, a.Attempt)
		}
		bt := effectsByType(eff)
		if len(bt[EffectCancelStage]) != 1 || len(bt[EffectStartStage]) != 1 {
			t.Fatalf("first timeout should cancel + restart, got %v", bt)
		}

		// Re-start, wedge again, second timeout -> budget exhausted -> finalize.
		st, _ = Reduce(st, StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		st = wedgeStage(st, "r1", "a", past)
		st, _ = Reduce(st, Tick{Now: testNow})
		final := st.Runs["r1"]
		if final.Stages["a"].Status != StageStatusFailed || final.Stages["a"].Attempt != 2 {
			t.Fatalf("final stage = %v attempt=%d, want failed attempt=2", final.Stages["a"].Status, final.Stages["a"].Attempt)
		}
		if final.LoopState != LoopStalled {
			t.Fatalf("run = %v, want stalled", final.LoopState)
		}
	})
}

// ---------------------------------------------------------------------------
// Per-stage maxLoopRounds
// ---------------------------------------------------------------------------

func TestMaxLoopRoundsSkip(t *testing.T) {
	t.Run("stage past its maxLoopRounds is skipped and cascades downstream", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		p.Stages[0].MaxLoopRounds = intPtr(2)
		run := runState("r1", p, nil)
		run.LoopRounds = 3 // over the cap for stage a.

		sched := scheduleAfterChange(run, testNow)
		if got := sched.run.Stages["a"].Status; got != StageStatusSkipped {
			t.Fatalf("stage a = %v, want skipped for exceeding maxLoopRounds", got)
		}
		if got := sched.run.Stages["b"].Status; got != StageStatusSkipped {
			t.Fatalf("stage b = %v, want cascade-skipped", got)
		}
		if !reflect.DeepEqual(sched.roundCappedSkips, []string{"a"}) {
			t.Fatalf("roundCappedSkips = %v, want [a]", sched.roundCappedSkips)
		}
		if !reflect.DeepEqual(sched.newlySkipped, []string{"b"}) {
			t.Fatalf("newlySkipped = %v, want [b] (cascade only)", sched.newlySkipped)
		}
		if len(sched.startEffects) != 0 {
			t.Fatalf("no stage should start, got %v", startedStageNames(sched.startEffects))
		}
		if !sched.allTerminal {
			t.Fatal("allTerminal should be true (both stages skipped)")
		}
	})

	t.Run("stage within its maxLoopRounds runs normally", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.Stages[0].MaxLoopRounds = intPtr(2)
		run := runState("r1", p, nil)
		run.LoopRounds = 2 // exactly at the cap, not over.

		sched := scheduleAfterChange(run, testNow)
		if got := startedStageNames(sched.startEffects); !reflect.DeepEqual(got, []string{"a"}) {
			t.Fatalf("started = %v, want [a]", got)
		}
		if len(sched.roundCappedSkips) != 0 {
			t.Fatalf("roundCappedSkips = %v, want none at the cap boundary", sched.roundCappedSkips)
		}
	})

	t.Run("round-capped skip emits a distinct observation at trigger", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.Stages[0].MaxLoopRounds = intPtr(1)
		// Prior SETTLED history so the continuation trigger derives LoopRounds > 1
		// (only done/stalled runs count toward the round counter).
		st := EmptyEngineState()
		st.HistorySummaries[LoopKey("sess-1", "p")] = []RunSummary{
			{RunID: "old", LoopState: LoopDone},
			{RunID: "old2", LoopState: LoopDone},
		}

		ev := triggerFor(p, TriggerPRUpdated, "r1")
		_, effects := Reduce(st, ev)
		if len(observationsNamed(effects, "pipeline.stage.skipped_max_rounds")) != 1 {
			t.Fatalf("want one pipeline.stage.skipped_max_rounds observation, got effects=%v", effects)
		}
	})
}

// ---------------------------------------------------------------------------
// Honest exit decisions
// ---------------------------------------------------------------------------

func TestHonestExitDecisions(t *testing.T) {
	doneNoOpenFindings := func() *ExitPredicates {
		return &ExitPredicates{Done: &Predicate{Kind: PredicateNoOpenFindings}}
	}

	t.Run("done configured but false, no stalled predicate, terminates stalled (never completed)", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.ExitPredicates = doneNoOpenFindings()
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		// Completing with an open finding leaves `done` (no_open_findings) false.
		state, _ := Reduce(engineWith(run), StageCompleted{
			Now: testNow, RunID: "r1", StageName: "a", Verdict: VerdictPass,
			Artifacts: []ArtifactInput{findingInput("x.go", "bug", "correctness", SeverityError)},
		})
		final := state.Runs["r1"]
		if final.LoopState != LoopStalled {
			t.Fatalf("run loopState = %v, want stalled (done predicate unmet)", final.LoopState)
		}
		if final.TerminationReason != TerminationDonePredicateUnmet {
			t.Fatalf("reason = %v, want done_predicate_unmet (never completed)", final.TerminationReason)
		}
	})

	t.Run("done false with stalled true terminates stalled", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.ExitPredicates = &ExitPredicates{
			Done:    &Predicate{Kind: PredicateNoOpenFindings},
			Stalled: &Predicate{Kind: PredicateLoopRoundsAtLeast, N: intPtr(1)},
		}
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), StageCompleted{
			Now: testNow, RunID: "r1", StageName: "a",
			Artifacts: []ArtifactInput{findingInput("x.go", "bug", "correctness", SeverityError)},
		})
		final := state.Runs["r1"]
		if final.LoopState != LoopStalled || final.TerminationReason != TerminationStageFailure {
			t.Fatalf("run = %v/%v, want stalled/stage_failure (stalled predicate wins)", final.LoopState, final.TerminationReason)
		}
	})

	t.Run("done true terminates done/completed", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.ExitPredicates = doneNoOpenFindings()
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		// No findings -> no_open_findings is true.
		state, _ := Reduce(engineWith(run), StageCompleted{Now: testNow, RunID: "r1", StageName: "a"})
		final := state.Runs["r1"]
		if final.LoopState != LoopDone || final.TerminationReason != TerminationCompleted {
			t.Fatalf("run = %v/%v, want done/completed", final.LoopState, final.TerminationReason)
		}
	})

	t.Run("no exit predicates keep v0 behavior", func(t *testing.T) {
		// Success with an open finding and no predicates -> v0 default -> completed.
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), StageCompleted{
			Now: testNow, RunID: "r1", StageName: "a",
			Artifacts: []ArtifactInput{findingInput("x.go", "bug", "correctness", SeverityError)},
		})
		final := state.Runs["r1"]
		if final.LoopState != LoopDone || final.TerminationReason != TerminationCompleted {
			t.Fatalf("run = %v/%v, want v0 done/completed", final.LoopState, final.TerminationReason)
		}

		// A failed stage with no predicates -> v0 default -> stalled/stage_failure.
		p2 := pipelineOf("p2", 1, stageDef("a"))
		run2 := runState("r2", p2, map[string]StageStatus{"a": StageStatusRunning})
		state2, _ := Reduce(engineWith(run2), StageFailed{Now: testNow, RunID: "r2", StageName: "a", ErrorMessage: "x"})
		final2 := state2.Runs["r2"]
		if final2.LoopState != LoopStalled || final2.TerminationReason != TerminationStageFailure {
			t.Fatalf("run = %v/%v, want v0 stalled/stage_failure", final2.LoopState, final2.TerminationReason)
		}
	})
}
