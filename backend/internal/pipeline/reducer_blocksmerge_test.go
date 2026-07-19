package pipeline

import "testing"

func boolPtr(b bool) *bool { return &b }

// blocksWhenOpenFindings is a blocksMerge predicate that fires when open findings
// remain: not(no_open_findings). It is the natural "unresolved findings block the
// merge" shape and is deterministic from the run's materialized findings.
func blocksWhenOpenFindings() *ExitPredicates {
	return &ExitPredicates{BlocksMerge: &Predicate{
		Kind:      PredicateNot,
		Predicate: &Predicate{Kind: PredicateNoOpenFindings},
	}}
}

func stageWithBlockingPolicy(name string) Stage {
	s := stageDef(name)
	s.Policy = &StagePolicy{BlocksMerge: boolPtr(true)}
	return s
}

func TestRunSetsBlocksMerge(t *testing.T) {
	t.Run("blocksMerge predicate true sets BlocksMerge", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.ExitPredicates = blocksWhenOpenFindings()
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		// An open finding remains, so not(no_open_findings) is true.
		state, effects := Reduce(engineWith(run), StageCompleted{
			Now: testNow, RunID: "r1", StageName: "a", Verdict: VerdictPass,
			Artifacts: []ArtifactInput{findingInput("x.go", "bug", "correctness", SeverityError)},
		})
		final := state.Runs["r1"]
		if !final.BlocksMerge {
			t.Fatalf("BlocksMerge = false, want true (blocksMerge predicate matched open finding)")
		}
		if got := observationsNamed(effects, "pipeline.run.blocks_merge"); len(got) != 1 {
			t.Fatalf("blocks_merge observations = %d, want 1", len(got))
		}
	})

	t.Run("blocksMerge predicate false leaves BlocksMerge unset", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.ExitPredicates = blocksWhenOpenFindings()
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		// No findings -> no_open_findings true -> not(...) false.
		state, effects := Reduce(engineWith(run), StageCompleted{Now: testNow, RunID: "r1", StageName: "a"})
		final := state.Runs["r1"]
		if final.BlocksMerge {
			t.Fatalf("BlocksMerge = true, want false (no open findings)")
		}
		if got := observationsNamed(effects, "pipeline.run.blocks_merge"); len(got) != 0 {
			t.Fatalf("blocks_merge observations = %d, want 0", len(got))
		}
	})

	t.Run("finally-failed stage with blocking policy sets BlocksMerge without a predicate", func(t *testing.T) {
		p := pipelineOf("p", 1, stageWithBlockingPolicy("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, effects := Reduce(engineWith(run), StageFailed{Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "boom"})
		final := state.Runs["r1"]
		if final.LoopState != LoopStalled {
			t.Fatalf("loopState = %v, want stalled", final.LoopState)
		}
		if !final.BlocksMerge {
			t.Fatalf("BlocksMerge = false, want true (failed stage policy blocks merge)")
		}
		if got := observationsNamed(effects, "pipeline.run.blocks_merge"); len(got) != 1 {
			t.Fatalf("blocks_merge observations = %d, want 1", len(got))
		}
	})

	t.Run("blocking policy on a non-failed stage does not block", func(t *testing.T) {
		p := pipelineOf("p", 1, stageWithBlockingPolicy("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		// Stage succeeds; the policy only blocks on a finally-failed stage.
		state, _ := Reduce(engineWith(run), StageCompleted{Now: testNow, RunID: "r1", StageName: "a", Verdict: VerdictPass})
		if state.Runs["r1"].BlocksMerge {
			t.Fatalf("BlocksMerge = true, want false (blocking policy stage succeeded)")
		}
	})
}

func TestRunBlocksMergeSupersededNeverBlocks(t *testing.T) {
	// A run whose failed stage policy AND blocksMerge predicate would both block.
	p := pipelineOf("p", 1, stageWithBlockingPolicy("a"))
	p.ExitPredicates = blocksWhenOpenFindings()
	run := runState("r1", p, map[string]StageStatus{"a": StageStatusFailed})
	run.Findings = []Artifact{{ArtifactInput: ArtifactInput{Kind: ArtifactKindFinding}, Status: ArtifactStatusOpen, Fingerprint: "fp"}}

	for _, reason := range []RunTerminationReason{TerminationOutdated, TerminationManualCancel, TerminationConfigChange} {
		if runBlocksMerge(EmptyEngineState(), run, reason) {
			t.Fatalf("reason %s must never block merge (run was superseded)", reason)
		}
	}
	// Sanity: a genuine terminal reason with the same state does block, proving
	// the superseded guard, not a wiring gap, is what suppresses the block.
	if !runBlocksMerge(EmptyEngineState(), run, TerminationStageFailure) {
		t.Fatal("stage_failure with a blocking policy stage should block merge")
	}
}
