package pipeline

import (
	"reflect"
	"testing"
)

// triggerFor builds a TRIGGER_FIRED event for pipeline p.
func triggerFor(p Pipeline, trigger StageTriggerEvent, runID RunID) TriggerFired {
	return TriggerFired{
		Now:         testNow,
		Trigger:     trigger,
		SessionID:   "sess-1",
		Pipeline:    p,
		HeadSHA:     "sha-1",
		RunID:       runID,
		StageRunIDs: stageRunIDsFor(p),
	}
}

// findingInput builds a finding ArtifactInput.
func findingInput(file, title, category string, sev Severity) ArtifactInput {
	return ArtifactInput{
		Kind: ArtifactKindFinding, FilePath: file, Title: title,
		Category: category, Severity: sev, StartLine: 10, EndLine: 12,
	}
}

// ---------------------------------------------------------------------------
// TRIGGER_FIRED
// ---------------------------------------------------------------------------

func TestReduceTriggerFired(t *testing.T) {
	t.Run("creates a run, claims the loop key, and starts the root stage", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		state, effects := Reduce(EmptyEngineState(), triggerFor(p, TriggerManual, "r1"))

		run, ok := state.Runs["r1"]
		if !ok {
			t.Fatal("run r1 not created")
		}
		if run.LoopState != LoopRunning {
			t.Fatalf("loopState = %v, want running", run.LoopState)
		}
		if run.LoopRounds != 1 {
			t.Fatalf("loopRounds = %d, want 1", run.LoopRounds)
		}
		if state.CurrentRunByLoop[LoopKey("sess-1", "p")] != "r1" {
			t.Fatal("loop key not pointing at r1")
		}
		if got := startedStageNames(effects); !reflect.DeepEqual(got, []string{"a"}) {
			t.Fatalf("started = %v, want [a]", got)
		}
		byType := effectsByType(effects)
		if len(byType[EffectPersistRun]) != 1 || len(byType[EffectPersistLoopState]) != 1 {
			t.Fatalf("want one PersistRun + one PersistLoopState, got %v", byType)
		}
	})

	t.Run("stores the run context on the new run", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		ev := triggerFor(p, TriggerPROpened, "r1")
		fork := false
		ev.Context = RunContext{
			PRNumber: 9, PRURL: "https://x/pull/9", SourceBranch: "feat",
			TargetBranch: "main", HeadSHA: "sha-1", SessionID: "sess-1", IsFromFork: &fork,
		}
		state, _ := Reduce(EmptyEngineState(), ev)
		got := state.Runs["r1"].Context
		if !reflect.DeepEqual(got, ev.Context) {
			t.Fatalf("run context = %+v, want %+v", got, ev.Context)
		}
	})

	t.Run("manual trigger leaves PR fields empty", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		ev := triggerFor(p, TriggerManual, "r1")
		ev.Context = RunContext{SessionID: "sess-1", HeadSHA: "sha-1"}
		state, _ := Reduce(EmptyEngineState(), ev)
		got := state.Runs["r1"].Context
		if got.PRNumber != 0 || got.PRURL != "" || got.SourceBranch != "" ||
			got.TargetBranch != "" || got.IsFromFork != nil {
			t.Fatalf("manual run must have empty PR fields, got %+v", got)
		}
		if got.SessionID != "sess-1" || got.HeadSHA != "sha-1" {
			t.Fatalf("manual run should keep session/head sha, got %+v", got)
		}
	})

	t.Run("second trigger for a live loop is a no-op", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		state, _ := Reduce(EmptyEngineState(), triggerFor(p, TriggerManual, "r1"))
		state2, effects := Reduce(state, triggerFor(p, TriggerManual, "r2"))
		if _, exists := state2.Runs["r2"]; exists {
			t.Fatal("r2 should not have been created while r1 is live")
		}
		if len(effects) != 0 {
			t.Fatalf("expected no effects, got %v", effects)
		}
	})

	t.Run("missing stageRunIds is an invalid transition", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b"))
		ev := triggerFor(p, TriggerManual, "r1")
		delete(ev.StageRunIDs, "b")
		state, effects := Reduce(EmptyEngineState(), ev)
		if len(state.Runs) != 0 {
			t.Fatal("no run should be created")
		}
		requireOneEffect[EmitObservation](t, effects)
		if effects[0].(EmitObservation).Name != "pipeline.invalid_transition" {
			t.Fatalf("want invalid_transition, got %v", effects[0])
		}
	})

	t.Run("pr.opened after history keeps loopRounds at max(settled prior,1)", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st := EmptyEngineState()
		key := LoopKey("sess-1", "p")
		st.HistorySummaries[key] = []RunSummary{
			{RunID: "old1", LoopState: LoopDone}, {RunID: "old2", LoopState: LoopStalled},
		}
		state, _ := Reduce(st, triggerFor(p, TriggerPROpened, "r1"))
		if state.Runs["r1"].LoopRounds != 2 {
			t.Fatalf("loopRounds = %d, want 2", state.Runs["r1"].LoopRounds)
		}
	})

	t.Run("manual continuation increments loopRounds past settled history", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st := EmptyEngineState()
		key := LoopKey("sess-1", "p")
		st.HistorySummaries[key] = []RunSummary{
			{RunID: "old1", LoopState: LoopDone}, {RunID: "old2", LoopState: LoopStalled},
		}
		state, _ := Reduce(st, triggerFor(p, TriggerManual, "r1"))
		if state.Runs["r1"].LoopRounds != 3 {
			t.Fatalf("loopRounds = %d, want 3", state.Runs["r1"].LoopRounds)
		}
	})

	t.Run("loopRounds ignores outdated/cancelled history", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		st := EmptyEngineState()
		key := LoopKey("sess-1", "p")
		// Two settled rounds plus three runs cut short (terminated); only the
		// settled two count toward the round number.
		st.HistorySummaries[key] = []RunSummary{
			{RunID: "done1", LoopState: LoopDone},
			{RunID: "outdated", LoopState: LoopTerminated, TerminationReason: TerminationOutdated},
			{RunID: "cancelled", LoopState: LoopTerminated, TerminationReason: TerminationManualCancel},
			{RunID: "stalled1", LoopState: LoopStalled},
			{RunID: "cfg", LoopState: LoopTerminated, TerminationReason: TerminationConfigChange},
		}
		state, _ := Reduce(st, triggerFor(p, TriggerManual, "r1"))
		if state.Runs["r1"].LoopRounds != 3 {
			t.Fatalf("loopRounds = %d, want 3 (2 settled prior + 1 continuation)", state.Runs["r1"].LoopRounds)
		}
	})

	t.Run("degenerate all-skip at trigger terminates the run cleanly", func(t *testing.T) {
		// b routes on an empty all_pass over a non-existent context, but the
		// canonical degenerate case: a fails-out immediately is impossible at
		// trigger. Instead use a routed stage whose predicate can never pass
		// because it references only itself's peers that are absent -> we build
		// a single stage whose routes references a stage that is already
		// terminal-skipped. Simplest: one stage routed on any_pass of a stage
		// that does not exist is caught by validation; so we use majority_pass
		// over an empty stage list, which is always false and has no refs.
		only := withRoutes(stageDef("only"), Predicate{Kind: PredicateMajorityPass, Stages: []string{}})
		p := pipelineOf("p", 1, only)
		state, effects := Reduce(EmptyEngineState(), triggerFor(p, TriggerManual, "r1"))
		run := state.Runs["r1"]
		if run.LoopState != LoopDone {
			t.Fatalf("loopState = %v, want done (no failed stages -> v0 default done)", run.LoopState)
		}
		if _, live := state.CurrentRunByLoop[LoopKey("sess-1", "p")]; live {
			t.Fatal("loop key should be freed after terminal trigger")
		}
		byType := effectsByType(effects)
		if len(byType[EffectStartStage]) != 0 {
			t.Fatal("no stage should start")
		}
		if len(state.HistorySummaries[LoopKey("sess-1", "p")]) != 1 {
			t.Fatal("history summary should be appended")
		}
	})
}

// ---------------------------------------------------------------------------
// STAGE_STARTED / STAGE_COMPLETED / STAGE_FAILED
// ---------------------------------------------------------------------------

func TestReduceStageStarted(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	run := runState("r1", p, nil)

	t.Run("pending -> running", func(t *testing.T) {
		state, effects := Reduce(engineWith(run), StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		if state.Runs["r1"].Stages["a"].Status != StageStatusRunning {
			t.Fatal("stage a should be running")
		}
		if state.Runs["r1"].Stages["a"].StartedAt == nil {
			t.Fatal("startedAt should be set")
		}
		requireOneEffect[PersistRun](t, effects)
	})

	t.Run("unknown run is invalid", func(t *testing.T) {
		_, effects := Reduce(engineWith(run), StageStarted{Now: testNow, RunID: "ghost", StageName: "a"})
		assertInvalid(t, effects)
	})

	t.Run("non-pending stage is invalid", func(t *testing.T) {
		r := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		_, effects := Reduce(engineWith(r), StageStarted{Now: testNow, RunID: "r1", StageName: "a"})
		assertInvalid(t, effects)
	})
}

func TestReduceStageCompleted(t *testing.T) {
	t.Run("single stage completing terminates the run as done", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, effects := Reduce(engineWith(run), StageCompleted{
			Now: testNow, RunID: "r1", StageName: "a", Verdict: VerdictPass,
			Artifacts: []ArtifactInput{findingInput("x.go", "bug", "correctness", SeverityError)},
		})
		final := state.Runs["r1"]
		if final.LoopState != LoopDone || final.TerminationReason != TerminationCompleted {
			t.Fatalf("run = %v/%v, want done/completed", final.LoopState, final.TerminationReason)
		}
		if final.Stages["a"].Status != StageStatusSucceeded {
			t.Fatal("stage a should be succeeded")
		}
		if len(final.Findings) != 1 || final.Findings[0].Fingerprint == "" {
			t.Fatalf("expected 1 mirrored finding with a fingerprint, got %+v", final.Findings)
		}
		if len(final.Fingerprints) != 1 {
			t.Fatalf("expected 1 accumulated fingerprint, got %v", final.Fingerprints)
		}
		byType := effectsByType(effects)
		if len(byType[EffectAppendArtifacts]) != 1 {
			t.Fatal("want an AppendArtifacts effect")
		}
		if _, live := state.CurrentRunByLoop[LoopKey("sess-1", "p")]; live {
			t.Fatal("loop key should be freed")
		}
	})

	t.Run("completing an upstream starts the downstream without terminating", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, effects := Reduce(engineWith(run), StageCompleted{Now: testNow, RunID: "r1", StageName: "a"})
		if state.Runs["r1"].LoopState != LoopRunning {
			t.Fatal("run should still be running")
		}
		if got := startedStageNames(effects); !reflect.DeepEqual(got, []string{"b"}) {
			t.Fatalf("started = %v, want [b]", got)
		}
		// PersistRun must precede the START_STAGE in the non-terminal path.
		requireOneEffect[PersistRun](t, effects)
	})

	t.Run("completing a non-running stage is invalid", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, nil) // a is pending
		_, effects := Reduce(engineWith(run), StageCompleted{Now: testNow, RunID: "r1", StageName: "a"})
		assertInvalid(t, effects)
	})

	t.Run("session id and notes land on the stage state", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), StageCompleted{
			Now: testNow, RunID: "r1", StageName: "a", Verdict: VerdictPass,
			SessionID: "sess-9", Notes: []string{"stage skipped: fork PR"},
		})
		stage := state.Runs["r1"].Stages["a"]
		if stage.SessionID != "sess-9" {
			t.Fatalf("session id = %q, want sess-9", stage.SessionID)
		}
		if len(stage.Notes) != 1 || stage.Notes[0] != "stage skipped: fork PR" {
			t.Fatalf("notes = %v, want one fork-skip line", stage.Notes)
		}
	})
}

func TestReduceStageNotesCapped(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
	notes := make([]string, MaxStageNotes+5)
	for i := range notes {
		notes[i] = "note"
	}
	state, _ := Reduce(engineWith(run), StageFailed{
		Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "boom", SessionID: "sess-9", Notes: notes,
	})
	if got := len(state.Runs["r1"].Stages["a"].Notes); got != MaxStageNotes {
		t.Fatalf("notes len = %d, want capped at %d", got, MaxStageNotes)
	}
	if state.Runs["r1"].Stages["a"].SessionID != "sess-9" {
		t.Fatal("failed stage must still carry its session id")
	}
}

func TestReduceStageFailed(t *testing.T) {
	t.Run("failure with no recovery terminates the run as stalled", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), StageFailed{Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "boom"})
		final := state.Runs["r1"]
		if final.LoopState != LoopStalled || final.TerminationReason != TerminationStageFailure {
			t.Fatalf("run = %v/%v, want stalled/stage_failure", final.LoopState, final.TerminationReason)
		}
		if final.Stages["b"].Status != StageStatusSkipped {
			t.Fatal("downstream b should be cascade-skipped")
		}
		if final.Stages["a"].ErrorMessage != "boom" {
			t.Fatal("error message should be recorded")
		}
	})

	t.Run("failed pending stage is allowed", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		run := runState("r1", p, nil) // pending
		state, _ := Reduce(engineWith(run), StageFailed{Now: testNow, RunID: "r1", StageName: "a", ErrorMessage: "x"})
		if state.Runs["r1"].Stages["a"].Status != StageStatusFailed {
			t.Fatal("pending stage should be allowed to fail")
		}
	})
}

// ---------------------------------------------------------------------------
// NEW_SHA_DETECTED / RUN_CANCELLED / CONFIG_CHANGED
// ---------------------------------------------------------------------------

func TestReduceNewSHADetected(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))

	t.Run("new sha cancels the run as outdated and frees the loop key", func(t *testing.T) {
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, effects := Reduce(engineWith(run), NewSHADetected{Now: testNow, SessionID: "sess-1", PipelineName: "p", SHA: "sha-2"})
		final := state.Runs["r1"]
		if final.LoopState != LoopTerminated || final.TerminationReason != TerminationOutdated {
			t.Fatalf("run = %v/%v, want terminated/outdated", final.LoopState, final.TerminationReason)
		}
		if final.Stages["a"].Status != StageStatusOutdated {
			t.Fatal("running stage should become outdated")
		}
		if _, live := state.CurrentRunByLoop[LoopKey("sess-1", "p")]; live {
			t.Fatal("loop key should be freed for the new SHA")
		}
		if len(effectsByType(effects)[EffectCancelStage]) != 1 {
			t.Fatal("running stage should emit CANCEL_STAGE")
		}
	})

	t.Run("same sha is a no-op", func(t *testing.T) {
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		_, effects := Reduce(engineWith(run), NewSHADetected{Now: testNow, SessionID: "sess-1", PipelineName: "p", SHA: "sha-1"})
		if len(effects) != 0 {
			t.Fatalf("expected no effects, got %v", effects)
		}
	})

	t.Run("no active run is a no-op", func(t *testing.T) {
		_, effects := Reduce(EmptyEngineState(), NewSHADetected{Now: testNow, SessionID: "sess-1", PipelineName: "p", SHA: "sha-2"})
		if len(effects) != 0 {
			t.Fatalf("expected no effects, got %v", effects)
		}
	})
}

func TestReduceRunCancelled(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))

	t.Run("manual cancel terminates", func(t *testing.T) {
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), RunCancelled{Now: testNow, RunID: "r1", Reason: TerminationManualCancel})
		if state.Runs["r1"].LoopState != LoopTerminated {
			t.Fatalf("want terminated, got %v", state.Runs["r1"].LoopState)
		}
	})

	t.Run("stage_failure reason stalls", func(t *testing.T) {
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), RunCancelled{Now: testNow, RunID: "r1", Reason: TerminationStageFailure})
		if state.Runs["r1"].LoopState != LoopStalled {
			t.Fatalf("want stalled, got %v", state.Runs["r1"].LoopState)
		}
	})

	t.Run("cancelling an already-terminal run is invalid", func(t *testing.T) {
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusSucceeded})
		run.LoopState = LoopDone
		_, effects := Reduce(engineWith(run), RunCancelled{Now: testNow, RunID: "r1", Reason: TerminationManualCancel})
		assertInvalid(t, effects)
	})
}

func TestReduceConfigChanged(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
	state, _ := Reduce(engineWith(run), ConfigChanged{Now: testNow, SessionID: "sess-1", PipelineName: "p"})
	if state.Runs["r1"].TerminationReason != TerminationConfigChange {
		t.Fatalf("want config_change, got %v", state.Runs["r1"].TerminationReason)
	}
	if state.Runs["r1"].LoopState != LoopTerminated {
		t.Fatalf("want terminated, got %v", state.Runs["r1"].LoopState)
	}
}

// ---------------------------------------------------------------------------
// ARTIFACT_STATUS_CHANGED / TICK
// ---------------------------------------------------------------------------

func TestReduceArtifactStatusChanged(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	run := runState("r1", p, map[string]StageStatus{"a": StageStatusSucceeded})
	run.Findings = []Artifact{{
		ArtifactInput: ArtifactInput{Kind: ArtifactKindFinding},
		ArtifactID:    "art-1", StageName: "a", Status: ArtifactStatusOpen,
	}}
	state, effects := Reduce(engineWith(run), ArtifactStatusChanged{
		Now: testNow, RunID: "r1", StageRunID: "sr-a", ArtifactID: "art-1",
		Status: ArtifactStatusDismissed, Actor: "reviewer",
	})
	if state.Runs["r1"].Findings[0].Status != ArtifactStatusDismissed {
		t.Fatal("finding status should be dismissed in the mirror")
	}
	byType := effectsByType(effects)
	if len(byType[EffectUpdateArtifactStatus]) != 1 || len(byType[EffectPersistRun]) != 1 {
		t.Fatalf("want UpdateArtifactStatus + PersistRun, got %v", byType)
	}
}

func TestReduceTick(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	run := runState("r1", p, nil)
	in := engineWith(run)
	state, effects := Reduce(in, Tick{Now: testNow})
	if len(effects) != 0 {
		t.Fatalf("tick should produce no effects, got %v", effects)
	}
	if !reflect.DeepEqual(state, in) {
		t.Fatal("tick should not change state")
	}
}

// ---------------------------------------------------------------------------
// Exit predicates + convergence
// ---------------------------------------------------------------------------

func TestExitPredicates(t *testing.T) {
	t.Run("done predicate resolves the run to done even with a failed stage", func(t *testing.T) {
		p := pipelineOf("p", 2, stageDef("a"), stageDef("b"))
		p.ExitPredicates = &ExitPredicates{
			Done: &Predicate{Kind: PredicateAnyPass, Stages: []string{"a"}},
		}
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusSucceeded, "b": StageStatusRunning})
		state, _ := Reduce(engineWith(run), StageFailed{Now: testNow, RunID: "r1", StageName: "b", ErrorMessage: "x"})
		final := state.Runs["r1"]
		if final.LoopState != LoopDone || final.TerminationReason != TerminationCompleted {
			t.Fatalf("run = %v/%v, want done/completed (done predicate wins)", final.LoopState, final.TerminationReason)
		}
	})

	t.Run("stalled predicate resolves the run to stalled", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		p.ExitPredicates = &ExitPredicates{
			Stalled: &Predicate{Kind: PredicateLoopRoundsAtLeast, N: intPtr(1)},
		}
		run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
		state, _ := Reduce(engineWith(run), StageCompleted{Now: testNow, RunID: "r1", StageName: "a"})
		final := state.Runs["r1"]
		if final.LoopState != LoopStalled || final.TerminationReason != TerminationStageFailure {
			t.Fatalf("run = %v/%v, want stalled/stage_failure", final.LoopState, final.TerminationReason)
		}
	})
}

func TestConvergence(t *testing.T) {
	// stallWindow=2: when the prior run's fingerprint set equals this run's,
	// terminate as converged -> stalled.
	sw := 2
	p := pipelineOf("p", 1, stageDef("a"))
	p.Stages[0].Policy = &StagePolicy{StallWindow: &sw}

	run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
	// Prior history with a matching fingerprint set.
	fp := computeFindingFingerprint(findingInput("x.go", "bug", "correctness", SeverityError), "a")
	st := engineWith(run)
	st.HistorySummaries[LoopKey("sess-1", "p")] = []RunSummary{{RunID: "old", Fingerprints: []string{fp}}}

	state, _ := Reduce(st, StageCompleted{
		Now: testNow, RunID: "r1", StageName: "a",
		Artifacts: []ArtifactInput{findingInput("x.go", "bug", "correctness", SeverityError)},
	})
	final := state.Runs["r1"]
	if final.TerminationReason != TerminationConverged || final.LoopState != LoopStalled {
		t.Fatalf("run = %v/%v, want converged/stalled", final.LoopState, final.TerminationReason)
	}
}

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

func TestReducerDoesNotMutateInput(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"), stageDef("b", "a"))
	run := runState("r1", p, map[string]StageStatus{"a": StageStatusRunning})
	in := engineWith(run)

	Reduce(in, StageCompleted{Now: testNow, RunID: "r1", StageName: "a"})

	if in.Runs["r1"].Stages["a"].Status != StageStatusRunning {
		t.Fatal("input run's stage a was mutated")
	}
	if in.Runs["r1"].LoopState != LoopRunning {
		t.Fatal("input run's loopState was mutated")
	}
	if len(in.Runs["r1"].Findings) != 0 {
		t.Fatal("input run's findings were mutated")
	}
}

func assertInvalid(t *testing.T, effects []Effect) {
	t.Helper()
	if len(effects) != 1 {
		t.Fatalf("expected exactly one (invalid_transition) effect, got %d: %v", len(effects), effects)
	}
	obs, ok := effects[0].(EmitObservation)
	if !ok || obs.Name != "pipeline.invalid_transition" {
		t.Fatalf("expected invalid_transition observation, got %v", effects[0])
	}
}
