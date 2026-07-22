package pipeline

import "time"

// reduceRunResumed resumes a stalled/failed run: it resets every failed stage
// back to pending with a fresh stageRunId (and incremented attempt, capped by
// stage.Retries when set), revives externally-cancelled outdated stages
// WITHOUT bumping attempt (they never really failed), re-pends cascade-skipped
// stages so downstream branches aren't lost, then re-arms the loop pointer. It
// no-ops when the run has nothing to resume.
//
// The retry/attempt distinction (spec §9 note 10) is load-bearing:
//   - failed stages are real retries: attempt++ and consume the retries budget.
//   - outdated stages were running when an external event (NEW_SHA_DETECTED,
//     CONFIG_CHANGED, a parallel-sibling failure) forced terminateRunFromState
//     to cancel them. That is not a stage failure, so reviving them must NOT
//     consume the retry cap. They keep their attempt counter and just get a
//     fresh stageRunId.
func reduceRunResumed(state EngineState, event RunResumed) (EngineState, []Effect) {
	now := event.Now
	run, ok := state.Runs[event.RunID]
	if !ok {
		return invalidTransition(state, "RUN_RESUMED for unknown runId="+string(event.RunID))
	}

	// Resume only applies to runs that have stopped advancing. The service
	// layer rejects non-terminal runs; this guard catches direct dispatch so
	// the reducer never re-arms a run the engine still considers active.
	if !run.LoopState.IsTerminal() {
		return invalidTransition(state, "RUN_RESUMED requires a terminal loop state; got "+string(run.LoopState)+" for "+string(event.RunID))
	}

	// Refuse to resume when another run already owns the loop key: resuming an
	// old stalled run after a fresh trigger claimed the loop would silently
	// dispossess the active run of its loop pointer.
	key := LoopKeyFor(run.Context, run.SessionID, run.PipelineName, run.RunID)
	if activeRunID, present := state.CurrentRunByLoop[key]; present && activeRunID != event.RunID {
		return invalidTransition(state, "RUN_RESUMED for "+string(event.RunID)+" but loop \""+key+"\" is already owned by active run "+string(activeRunID)+"; cancel that run before resuming the older one")
	}

	var failedStageNames, outdatedStageNames []string
	// Iterate pipeline stages (not the map) so the resumed stage-name lists are
	// in declaration order, giving deterministic observation payloads.
	for _, def := range run.PipelineConfigSnapshot.Stages {
		s, ok := run.Stages[def.Name]
		if !ok {
			continue
		}
		switch s.Status {
		case StageStatusFailed:
			failedStageNames = append(failedStageNames, def.Name)
		case StageStatusOutdated:
			outdatedStageNames = append(outdatedStageNames, def.Name)
		}
	}
	if len(failedStageNames) == 0 && len(outdatedStageNames) == 0 {
		if run.LoopState != LoopStalled {
			// Nothing to resume (e.g. a done/terminated run has no failed stages);
			// keep state unchanged so the caller can no-op too.
			return state, nil
		}
		// Rounds-stalled resume: the run stopped advancing with every stage
		// succeeded/skipped (e.g. a loop_rounds_at_least stalled predicate fired,
		// or `done` was unmet). There is nothing to retry, but resuming a stalled
		// run should grant a genuine extra round, so re-pend ALL stages with fresh
		// stageRunIds (attempt preserved: these stages did not fail, so they do not
		// consume the retry budget). LoopRounds and history are left untouched.
		//
		// Limitation: LoopRounds is not bumped, so a stage capped by maxLoopRounds
		// (or a loop_rounds_at_least stalled predicate) that stalled the run will
		// re-skip/re-stall on the next terminal; resume re-runs the eligible work
		// without advancing the round counter. Noted in the PR; bumping the counter
		// is owned by the trigger/loop-key worker (#270).
		roundResumeDelta := make(map[string]StageState, len(run.Stages))
		resumedNames := make([]string, 0, len(run.PipelineConfigSnapshot.Stages))
		for _, def := range run.PipelineConfigSnapshot.Stages {
			prior, ok := run.Stages[def.Name]
			if !ok {
				continue
			}
			fresh, ok := event.StageRunIDs[def.Name]
			if !ok || fresh == "" {
				return invalidTransition(state, "RUN_RESUMED (rounds) missing stageRunId for stage \""+def.Name+"\"")
			}
			roundResumeDelta[def.Name] = StageState{
				StageRunID: fresh,
				Status:     StageStatusPending,
				Attempt:    prior.Attempt,
			}
			resumedNames = append(resumedNames, def.Name)
		}
		return finishResume(state, run, key, roundResumeDelta, resumedNames, now)
	}

	retriesByName := make(map[string]*int, len(run.PipelineConfigSnapshot.Stages))
	for _, def := range run.PipelineConfigSnapshot.Stages {
		retriesByName[def.Name] = def.Retries
	}

	stageDelta := make(map[string]StageState)

	// Real retries: bump attempt, enforce the retries cap.
	for _, name := range failedStageNames {
		fresh, ok := event.StageRunIDs[name]
		if !ok || fresh == "" {
			return invalidTransition(state, "RUN_RESUMED missing stageRunId for failed stage \""+name+"\"")
		}
		prior := run.Stages[name]
		if retryCap := retriesByName[name]; retryCap != nil && prior.Attempt >= *retryCap+1 {
			return invalidTransition(state, "RUN_RESUMED would exceed stage.retries for \""+name+"\"")
		}
		stageDelta[name] = StageState{
			StageRunID: fresh,
			Status:     StageStatusPending,
			Attempt:    prior.Attempt + 1,
		}
	}

	// External cancellations: fresh stageRunId, but don't bump attempt or check
	// the cap.
	for _, name := range outdatedStageNames {
		fresh, ok := event.StageRunIDs[name]
		if !ok || fresh == "" {
			return invalidTransition(state, "RUN_RESUMED missing stageRunId for outdated stage \""+name+"\"")
		}
		prior := run.Stages[name]
		stageDelta[name] = StageState{
			StageRunID: fresh,
			Status:     StageStatusPending,
			Attempt:    prior.Attempt,
		}
	}

	// Revive stages that terminateRunFromState cascade-skipped when the run
	// failed: they never got an execution attempt, so they keep their existing
	// stageRunId, attempt, and artifacts. scheduleAfterChange re-skips any whose
	// routes predicate is genuinely unsatisfied, so predicate-driven skips are
	// not accidentally revived.
	for name, prior := range run.Stages {
		if prior.Status != StageStatusSkipped {
			continue
		}
		if _, taken := stageDelta[name]; taken {
			continue
		}
		stageDelta[name] = StageState{
			StageRunID: prior.StageRunID,
			Status:     StageStatusPending,
			Attempt:    prior.Attempt,
			Artifacts:  prior.Artifacts,
		}
	}

	resumedNames := append(append([]string{}, failedStageNames...), outdatedStageNames...)
	return finishResume(state, run, key, stageDelta, resumedNames, now)
}

// finishResume applies a resume delta (re-pended stages), re-runs the scheduler,
// and either persists+starts the re-armed stages or, when everything is already
// terminal again (e.g. every re-pended stage immediately re-skips), terminates
// the run honestly instead of leaving it running with no inflight stage. The
// pipeline.run.resumed observation names the stages the caller re-armed.
func finishResume(state EngineState, run RunState, key string, stageDelta map[string]StageState, resumedNames []string, now time.Time) (EngineState, []Effect) {
	updatedRun := patchRun(run, stageDelta, now)
	updatedRun.LoopState = LoopRunning
	updatedRun.TerminationReason = ""

	sched := scheduleAfterChange(updatedRun, now)
	finalRun := sched.run

	skipObs := skipObservations(run.RunID, sched.newlySkipped, finalRun)
	roundObs := roundCappedObservations(run.RunID, sched.roundCappedSkips, finalRun)
	resumedObs := EmitObservation{
		Name: "pipeline.run.resumed",
		Data: map[string]any{
			"runId":        run.RunID,
			"pipelineName": run.PipelineName,
			"stageNames":   resumedNames,
		},
	}

	if sched.allTerminal {
		base := replaceRun(state, finalRun)
		base = withCurrentRun(base, key, run.RunID)
		preceding := make([]Effect, 0, len(skipObs)+len(roundObs)+1)
		preceding = append(preceding, skipObs...)
		preceding = append(preceding, roundObs...)
		preceding = append(preceding, resumedObs)
		decision := decideRunExit(finalRun, base)
		return terminateRunFromState(base, finalRun, decision.reason, now, decision.loopState, preceding)
	}

	nextState := replaceRun(state, finalRun)
	nextState = withCurrentRun(nextState, key, run.RunID)

	effects := make([]Effect, 0, 2+len(sched.startEffects)+len(skipObs)+len(roundObs)+1)
	effects = append(effects,
		PersistRun{RunState: finalRun},
		PersistLoopState{RunID: run.RunID, LoopState: deriveLoopStateFromRun(finalRun, now)},
	)
	effects = append(effects, sched.startEffects...)
	effects = append(effects, skipObs...)
	effects = append(effects, roundObs...)
	effects = append(effects, resumedObs)
	return nextState, effects
}
