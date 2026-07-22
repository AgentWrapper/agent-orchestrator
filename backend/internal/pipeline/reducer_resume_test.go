package pipeline

import (
	"reflect"
	"testing"
)

// stalledRun builds a terminal (stalled) run with the given per-stage statuses
// and attempts, no longer owning its loop key (as after terminateRun).
func stalledRun(p Pipeline, statuses map[string]StageStatus, attempts map[string]int) (EngineState, RunState) {
	run := runState("r1", p, statuses)
	run.LoopState = LoopStalled
	run.TerminationReason = TerminationStageFailure
	for name, a := range attempts {
		s := run.Stages[name]
		s.Attempt = a
		run.Stages[name] = s
	}
	st := EmptyEngineState()
	st.Runs[run.RunID] = run
	// Loop key is already freed (run terminated).
	st.HistorySummaries[LoopKey(run.SessionID, run.PipelineName)] = []RunSummary{summarizeRun(run)}
	return st, run
}

func resumeIDs(names ...string) map[string]StageRunID {
	out := map[string]StageRunID{}
	for _, n := range names {
		out[n] = StageRunID("sr2-" + n)
	}
	return out
}

func TestReduceRunResumed(t *testing.T) {
	t.Run("failed stage is retried: attempt++ and fresh stageRunId", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusFailed}, map[string]int{"a": 1})
		state, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})

		final := state.Runs["r1"]
		if final.LoopState != LoopRunning {
			t.Fatalf("run should be running again, got %v", final.LoopState)
		}
		a := final.Stages["a"]
		if a.Status != StageStatusPending {
			t.Fatalf("stage a status = %v, want pending", a.Status)
		}
		if a.Attempt != 2 {
			t.Fatalf("failed retry should bump attempt to 2, got %d", a.Attempt)
		}
		if a.StageRunID != "sr2-a" {
			t.Fatalf("stage a should get a fresh stageRunId, got %v", a.StageRunID)
		}
		if state.CurrentRunByLoop[LoopKey("sess-1", "p")] != "r1" {
			t.Fatal("loop key should be re-armed")
		}
		if got := startedStageNames(effects); !reflect.DeepEqual(got, []string{"a"}) {
			t.Fatalf("started = %v, want [a]", got)
		}
	})

	t.Run("outdated stage revival keeps attempt (not a real failure)", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusOutdated}, map[string]int{"a": 3})
		st.Runs["r1"] = func() RunState { r := st.Runs["r1"]; r.LoopState = LoopTerminated; return r }()
		state, _ := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		a := state.Runs["r1"].Stages["a"]
		if a.Attempt != 3 {
			t.Fatalf("outdated revival must NOT bump attempt, got %d want 3", a.Attempt)
		}
		if a.Status != StageStatusPending || a.StageRunID != "sr2-a" {
			t.Fatalf("outdated stage should be pending with a fresh id, got %v/%v", a.Status, a.StageRunID)
		}
	})

	t.Run("retries cap is enforced for failed stages", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.Stages[0].Retries = intPtr(1) // allows attempts up to 2
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusFailed}, map[string]int{"a": 2})
		_, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		assertInvalid(t, effects)
	})

	t.Run("cascade-skipped downstream is revived on resume", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		// a failed, b was cascade-skipped when the run stalled.
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusFailed, "b": StageStatusSkipped}, map[string]int{"a": 1})
		state, _ := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		b := state.Runs["r1"].Stages["b"]
		if b.Status != StageStatusPending {
			t.Fatalf("skipped downstream b should be revived to pending, got %v", b.Status)
		}
		if b.StageRunID != "sr-b" {
			t.Fatalf("revived skip keeps its existing stageRunId, got %v", b.StageRunID)
		}
	})

	t.Run("nothing to resume is a no-op", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusSucceeded}, nil)
		st.Runs["r1"] = func() RunState { r := st.Runs["r1"]; r.LoopState = LoopDone; return r }()
		_, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		if len(effects) != 0 {
			t.Fatalf("expected no effects, got %v", effects)
		}
	})

	t.Run("resuming a non-terminal run is invalid", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusFailed})
		run.LoopState = LoopRunning // not terminal
		_, effects := Reduce(engineWith(run), RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		assertInvalid(t, effects)
	})

	t.Run("resuming when the loop is owned by another run is invalid", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusFailed}, map[string]int{"a": 1})
		// A fresh run now owns the loop key.
		st.CurrentRunByLoop[LoopKey("sess-1", "p")] = "r2"
		_, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		assertInvalid(t, effects)
	})

	t.Run("missing stageRunId for a failed stage is invalid", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusFailed}, map[string]int{"a": 1})
		_, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: map[string]StageRunID{}})
		assertInvalid(t, effects)
	})
}

func TestReduceRunResumedRoundsStalled(t *testing.T) {
	t.Run("rounds-stalled run with no failed stages re-pends ALL stages", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusSucceeded, "b": StageStatusSucceeded}, map[string]int{"a": 1, "b": 2})
		// The engine allocates fresh stageRunIds for every stage in this case.
		state, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a", "b")})

		final := state.Runs["r1"]
		if final.LoopState != LoopRunning {
			t.Fatalf("run should be running again, got %v", final.LoopState)
		}
		if final.Stages["a"].Status != StageStatusPending || final.Stages["b"].Status != StageStatusPending {
			t.Fatalf("both stages should be re-pended, got a=%v b=%v", final.Stages["a"].Status, final.Stages["b"].Status)
		}
		if final.Stages["a"].StageRunID != "sr2-a" || final.Stages["b"].StageRunID != "sr2-b" {
			t.Fatalf("stages should get fresh stageRunIds, got a=%v b=%v", final.Stages["a"].StageRunID, final.Stages["b"].StageRunID)
		}
		// Attempts are preserved (these stages succeeded, not failed).
		if final.Stages["a"].Attempt != 1 || final.Stages["b"].Attempt != 2 {
			t.Fatalf("attempts should be preserved, got a=%d b=%d", final.Stages["a"].Attempt, final.Stages["b"].Attempt)
		}
		// The root re-pended stage starts; b waits on a.
		if got := startedStageNames(effects); !reflect.DeepEqual(got, []string{"a"}) {
			t.Fatalf("started = %v, want [a]", got)
		}
		if state.CurrentRunByLoop[LoopKey("sess-1", "p")] != "r1" {
			t.Fatal("loop key should be re-armed")
		}
	})

	t.Run("resume of a non-stalled terminal run with no failed stages is a no-op", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st, _ := stalledRun(p, map[string]StageStatus{"a": StageStatusSucceeded}, nil)
		r := st.Runs["r1"]
		r.LoopState = LoopDone // done, not stalled: rounds-resume must not fire.
		r.TerminationReason = TerminationCompleted
		st.Runs["r1"] = r

		state, effects := Reduce(st, RunResumed{Now: testNow, RunID: "r1", StageRunIDs: resumeIDs("a")})
		if len(effects) != 0 {
			t.Fatalf("done run resume should be a no-op, got %v", effects)
		}
		if state.Runs["r1"].LoopState != LoopDone {
			t.Fatal("done run should be left unchanged")
		}
	})
}
