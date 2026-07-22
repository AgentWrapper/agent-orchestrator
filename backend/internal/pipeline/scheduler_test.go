package pipeline

import (
	"reflect"
	"testing"
)

func TestScheduleAfterChange(t *testing.T) {
	t.Run("linear pipeline starts only the root at trigger time", func(t *testing.T) {
		p := pipelineOf("lin", 1, stageDef("a"), stageDef("b", "a"), stageDef("c", "b"))
		run := runState("r1", p, nil)
		sched := scheduleAfterChange(run, testNow)
		if got := startedStageNames(sched.startEffects); !reflect.DeepEqual(got, []string{"a"}) {
			t.Fatalf("started = %v, want [a]", got)
		}
		if sched.allTerminal {
			t.Fatal("allTerminal should be false")
		}
		if len(sched.newlySkipped) != 0 {
			t.Fatalf("newlySkipped = %v, want none", sched.newlySkipped)
		}
	})

	t.Run("slot-fill respects MaxConcurrentStages and declaration order", func(t *testing.T) {
		p := pipelineOf("par", 2, stageDef("a"), stageDef("b"), stageDef("c"))
		run := runState("r1", p, nil)
		sched := scheduleAfterChange(run, testNow)
		if got := startedStageNames(sched.startEffects); !reflect.DeepEqual(got, []string{"a", "b"}) {
			t.Fatalf("started = %v, want [a b] (declaration order, capped at 2)", got)
		}
	})

	t.Run("running stages consume concurrency slots", func(t *testing.T) {
		p := pipelineOf("par", 2, stageDef("a"), stageDef("b"), stageDef("c"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		sched := scheduleAfterChange(run, testNow)
		if got := startedStageNames(sched.startEffects); !reflect.DeepEqual(got, []string{"b"}) {
			t.Fatalf("started = %v, want [b] (one slot left)", got)
		}
	})

	t.Run("default concurrency is 1", func(t *testing.T) {
		p := pipelineOf("par", 0, stageDef("a"), stageDef("b"))
		run := runState("r1", p, nil)
		sched := scheduleAfterChange(run, testNow)
		if got := startedStageNames(sched.startEffects); !reflect.DeepEqual(got, []string{"a"}) {
			t.Fatalf("started = %v, want [a]", got)
		}
	})

	t.Run("no-routes stage skips when a dependency failed, and cascades", func(t *testing.T) {
		p := pipelineOf("lin", 1, stageDef("a"), stageDef("b", "a"), stageDef("c", "b"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusFailed})
		sched := scheduleAfterChange(run, testNow)
		if !reflect.DeepEqual(sched.newlySkipped, []string{"b", "c"}) {
			t.Fatalf("newlySkipped = %v, want [b c] (cascade to fixpoint)", sched.newlySkipped)
		}
		if !sched.allTerminal {
			t.Fatal("allTerminal should be true (a failed, b+c skipped)")
		}
		if sched.run.Stages["b"].Status != StageStatusSkipped || sched.run.Stages["c"].Status != StageStatusSkipped {
			t.Fatal("b and c should be skipped in the returned run")
		}
	})

	t.Run("routes.when gates activation: false predicate skips the stage", func(t *testing.T) {
		// b activates only if a passed; a failed, so b is skipped.
		b := withRoutes(stageDef("b", "a"), Predicate{Kind: PredicateAnyPass, Stages: []string{"a"}})
		p := pipelineOf("routed", 1, stageDef("a"), b)
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusFailed})
		sched := scheduleAfterChange(run, testNow)
		if !reflect.DeepEqual(sched.newlySkipped, []string{"b"}) {
			t.Fatalf("newlySkipped = %v, want [b]", sched.newlySkipped)
		}
		if len(startedStageNames(sched.startEffects)) != 0 {
			t.Fatalf("expected no starts, got %v", startedStageNames(sched.startEffects))
		}
	})

	t.Run("routes.when recovery branch starts when the predicate matches a failure", func(t *testing.T) {
		// recover activates when a failed (stage_verdict fail).
		recoverStage := withRoutes(stageDef("recover", "a"),
			Predicate{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictFail})
		p := pipelineOf("routed", 1, stageDef("a"), recoverStage)
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusFailed})
		sched := scheduleAfterChange(run, testNow)
		if got := startedStageNames(sched.startEffects); !reflect.DeepEqual(got, []string{"recover"}) {
			t.Fatalf("started = %v, want [recover]", got)
		}
		if len(sched.newlySkipped) != 0 {
			t.Fatalf("newlySkipped = %v, want none", sched.newlySkipped)
		}
	})

	t.Run("stage waits until routes-referenced stage outside dependsOn is terminal", func(t *testing.T) {
		// b routes on c (not a dependsOn edge). While c is still running, b must
		// not be skipped or started: the decision isn't deterministic yet.
		b := withRoutes(stageDef("b"), Predicate{Kind: PredicateAnyPass, Stages: []string{"c"}})
		p := pipelineOf("cross", 2, b, stageDef("c"))
		run := runState("r1", p, map[string]StageStatus{"c": StageStatusRunning})
		sched := scheduleAfterChange(run, testNow)
		if len(sched.newlySkipped) != 0 {
			t.Fatalf("newlySkipped = %v, want none while c is running", sched.newlySkipped)
		}
		if names := startedStageNames(sched.startEffects); len(names) != 0 {
			t.Fatalf("started = %v, want none (b blocked on c, c already running)", names)
		}
	})
}
