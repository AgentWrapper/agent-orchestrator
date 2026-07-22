package pipeline

import "testing"

// triggerForPR builds a PR-backed TRIGGER_FIRED with a per-PR RunContext.
func triggerForPR(p Pipeline, trigger StageTriggerEvent, runID RunID, prURL, headSHA string) TriggerFired {
	ev := TriggerFired{
		Now:         testNow,
		Trigger:     trigger,
		SessionID:   "sess-1",
		Pipeline:    p,
		HeadSHA:     headSHA,
		RunID:       runID,
		StageRunIDs: stageRunIDsFor(p),
		Context: RunContext{
			PRURL: prURL, HeadSHA: headSHA, SessionID: "sess-1",
		},
	}
	return ev
}

// runToDone drives a single-stage run from a live trigger to a completed run.
func runToDone(t *testing.T, state EngineState, runID RunID, stage string) EngineState {
	t.Helper()
	state, _ = Reduce(state, StageStarted{Now: testNow, RunID: runID, StageName: stage})
	state, _ = Reduce(state, StageCompleted{Now: testNow, RunID: runID, StageName: stage})
	if state.Runs[runID].LoopState != LoopDone {
		t.Fatalf("run %s should be done, got %v", runID, state.Runs[runID].LoopState)
	}
	return state
}

func TestPerPRLoopKeys(t *testing.T) {
	t.Run("two PRs on one session run the same pipeline concurrently", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		state, _ := Reduce(EmptyEngineState(), triggerForPR(p, TriggerPROpened, "rA", "https://x/pull/A", "sha-a"))
		state, _ = Reduce(state, triggerForPR(p, TriggerPROpened, "rB", "https://x/pull/B", "sha-b"))

		if state.Runs["rA"].LoopState != LoopRunning || state.Runs["rB"].LoopState != LoopRunning {
			t.Fatalf("both runs should be live, got rA=%v rB=%v", state.Runs["rA"].LoopState, state.Runs["rB"].LoopState)
		}
		keyA := LoopKeyFor(RunContext{PRURL: "https://x/pull/A"}, "sess-1", "p", "")
		keyB := LoopKeyFor(RunContext{PRURL: "https://x/pull/B"}, "sess-1", "p", "")
		if state.CurrentRunByLoop[keyA] != "rA" || state.CurrentRunByLoop[keyB] != "rB" {
			t.Fatalf("per-PR keys not isolated: %+v", state.CurrentRunByLoop)
		}
	})

	t.Run("NEW_SHA for PR-B terminates only PR-B's run", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		state, _ := Reduce(EmptyEngineState(), triggerForPR(p, TriggerPROpened, "rA", "https://x/pull/A", "sha-a"))
		state, _ = Reduce(state, triggerForPR(p, TriggerPROpened, "rB", "https://x/pull/B", "sha-b"))

		state, _ = Reduce(state, NewSHADetected{Now: testNow, SessionID: "sess-1", PipelineName: "p", SHA: "sha-b2", PRURL: "https://x/pull/B"})

		if state.Runs["rA"].LoopState != LoopRunning {
			t.Fatalf("PR-A run must survive a PR-B SHA change, got %v", state.Runs["rA"].LoopState)
		}
		if state.Runs["rB"].LoopState != LoopTerminated || state.Runs["rB"].TerminationReason != TerminationOutdated {
			t.Fatalf("PR-B run should be outdated, got %v/%v", state.Runs["rB"].LoopState, state.Runs["rB"].TerminationReason)
		}
		keyA := LoopKeyFor(RunContext{PRURL: "https://x/pull/A"}, "sess-1", "p", "")
		keyB := LoopKeyFor(RunContext{PRURL: "https://x/pull/B"}, "sess-1", "p", "")
		if state.CurrentRunByLoop[keyA] != "rA" {
			t.Fatal("PR-A loop key must still point at rA")
		}
		if _, live := state.CurrentRunByLoop[keyB]; live {
			t.Fatal("PR-B loop key should be freed for the new SHA")
		}
	})

	t.Run("NEW_SHA for an unknown PR is a no-op", func(t *testing.T) {
		p := pipelineOf("p", 1, stageDef("a"))
		state, _ := Reduce(EmptyEngineState(), triggerForPR(p, TriggerPROpened, "rA", "https://x/pull/A", "sha-a"))
		_, effects := Reduce(state, NewSHADetected{Now: testNow, SessionID: "sess-1", PipelineName: "p", SHA: "sha-z", PRURL: "https://x/pull/Z"})
		if len(effects) != 0 {
			t.Fatalf("SHA change on an untracked PR should be a no-op, got %v", effects)
		}
	})
}

func TestSameSHATriggerDedup(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))

	t.Run("merge_ready flap at the same SHA does not create a second run", func(t *testing.T) {
		state, _ := Reduce(EmptyEngineState(), triggerForPR(p, TriggerPRMergeReady, "r1", "https://x/pull/A", "sha-a"))
		state = runToDone(t, state, "r1", "a")

		// CI flaps pass -> fail -> pass on the same SHA, re-firing the merge_ready
		// transition. The reducer must dedup it.
		state2, effects := Reduce(state, triggerForPR(p, TriggerPRMergeReady, "r2", "https://x/pull/A", "sha-a"))
		if _, exists := state2.Runs["r2"]; exists {
			t.Fatal("a second run must not be created at an already-settled SHA")
		}
		if len(effects) != 1 {
			t.Fatalf("want a single dedup observation, got %d effects", len(effects))
		}
		if obs, ok := effects[0].(EmitObservation); !ok || obs.Name != "pipeline.run.trigger_deduped" {
			t.Fatalf("want trigger_deduped observation, got %v", effects[0])
		}
	})

	t.Run("a different SHA is not deduped", func(t *testing.T) {
		state, _ := Reduce(EmptyEngineState(), triggerForPR(p, TriggerPRMergeReady, "r1", "https://x/pull/A", "sha-a"))
		state = runToDone(t, state, "r1", "a")

		state2, _ := Reduce(state, triggerForPR(p, TriggerPRMergeReady, "r2", "https://x/pull/A", "sha-b"))
		if _, exists := state2.Runs["r2"]; !exists {
			t.Fatal("a new SHA must start a fresh run")
		}
	})

	t.Run("an outdated prior run at the SHA does not dedup a re-trigger", func(t *testing.T) {
		// Prior run at sha-a was cut short (outdated), so the SHA was never run to
		// a conclusion; a re-trigger must be allowed.
		st := EmptyEngineState()
		key := LoopKeyFor(RunContext{PRURL: "https://x/pull/A"}, "sess-1", "p", "")
		st.HistorySummaries[key] = []RunSummary{
			{RunID: "old", HeadSHA: "sha-a", LoopState: LoopTerminated, TerminationReason: TerminationOutdated},
		}
		state, _ := Reduce(st, triggerForPR(p, TriggerPRMergeReady, "r2", "https://x/pull/A", "sha-a"))
		if _, exists := state.Runs["r2"]; !exists {
			t.Fatal("a re-trigger after an outdated run at this SHA must fire")
		}
	})

	t.Run("manual trigger always fires even at an already-run SHA", func(t *testing.T) {
		st := EmptyEngineState()
		// Manual-with-session key; a settled prior run sits at sha-a.
		key := LoopKeyFor(RunContext{SessionID: "sess-1"}, "sess-1", "p", "")
		st.HistorySummaries[key] = []RunSummary{
			{RunID: "old", HeadSHA: "sha-a", LoopState: LoopDone},
		}
		ev := triggerFor(p, TriggerManual, "r1")
		ev.HeadSHA = "sha-a"
		ev.Context = RunContext{SessionID: "sess-1", HeadSHA: "sha-a"}
		state, _ := Reduce(st, ev)
		if _, exists := state.Runs["r1"]; !exists {
			t.Fatal("a manual trigger must fire even at an already-settled SHA")
		}
	})
}

func TestUnscopedManualRunsCoexist(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	mk := func(runID RunID) TriggerFired {
		return TriggerFired{
			Now: testNow, Trigger: TriggerManual, SessionID: "", Pipeline: p,
			HeadSHA: "", RunID: runID, StageRunIDs: stageRunIDsFor(p),
			Context: RunContext{},
		}
	}
	state, _ := Reduce(EmptyEngineState(), mk("m1"))
	state, _ = Reduce(state, mk("m2"))

	if state.Runs["m1"].LoopState != LoopRunning || state.Runs["m2"].LoopState != LoopRunning {
		t.Fatalf("both unscoped manual runs should be live, got m1=%v m2=%v", state.Runs["m1"].LoopState, state.Runs["m2"].LoopState)
	}
	if state.CurrentRunByLoop["run:m1"] != "m1" || state.CurrentRunByLoop["run:m2"] != "m2" {
		t.Fatalf("unscoped manual runs must not collide: %+v", state.CurrentRunByLoop)
	}
}

func TestConfigChangedTerminatesAllPRRuns(t *testing.T) {
	p := pipelineOf("p", 1, stageDef("a"))
	state, _ := Reduce(EmptyEngineState(), triggerForPR(p, TriggerPROpened, "rA", "https://x/pull/A", "sha-a"))
	state, _ = Reduce(state, triggerForPR(p, TriggerPROpened, "rB", "https://x/pull/B", "sha-b"))

	state, _ = Reduce(state, ConfigChanged{Now: testNow, SessionID: "sess-1", PipelineName: "p"})

	for _, id := range []RunID{"rA", "rB"} {
		if state.Runs[id].LoopState != LoopTerminated || state.Runs[id].TerminationReason != TerminationConfigChange {
			t.Fatalf("run %s should be config-change terminated, got %v/%v", id, state.Runs[id].LoopState, state.Runs[id].TerminationReason)
		}
	}
	if len(state.CurrentRunByLoop) != 0 {
		t.Fatalf("all loop keys should be freed, got %+v", state.CurrentRunByLoop)
	}
}
