package pipeline

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// DefaultStageTimeout is the wall-clock deadline applied to a running stage when
// its Stage.TimeoutMs is unset (or non-positive). STAGE_STARTED stamps
// StartedAt + this onto the stage; the reducer's TICK arm fails any stage past
// its deadline so a wedged executor cannot leave the run running forever.
const DefaultStageTimeout = 30 * time.Minute

// Pure pipeline reducer.
//
// Signature: Reduce(state, event) -> (state', effects). The reducer is
// synchronous and pure: it never reads the clock and never performs I/O. Every
// event carries a driver-stamped Now so timestamps are fixed at enqueue time.
// Effects are intent-only; the engine (a later task) executes them and feeds
// results back as new events.
//
// Ported from the old TypeScript reducer.ts, minus the deferred USER_FOLLOWUP /
// FOLLOWUP_REPLY events (phase 2) and the dropped v0_default exit-predicate
// placeholder (greenfield).

// Reduce applies event to state, returning the next state and the effects the
// driver must execute. The input state is never mutated.
func Reduce(state EngineState, event Event) (EngineState, []Effect) {
	switch e := event.(type) {
	case TriggerFired:
		return reduceTriggerFired(state, e)
	case StageStarted:
		return reduceStageStarted(state, e)
	case StageCompleted:
		return reduceStageCompleted(state, e)
	case StageFailed:
		return reduceStageFailed(state, e)
	case NewSHADetected:
		return reduceNewSHADetected(state, e)
	case RunCancelled:
		return reduceRunCancelled(state, e)
	case RunResumed:
		return reduceRunResumed(state, e)
	case ConfigChanged:
		return reduceConfigChanged(state, e)
	case ArtifactStatusChanged:
		return reduceArtifactStatusChanged(state, e)
	case Tick:
		return reduceTick(state, e)
	default:
		return invalidTransition(state, "unknown event type")
	}
}

func reduceTriggerFired(state EngineState, event TriggerFired) (EngineState, []Effect) {
	now := event.Now
	key := LoopKeyFor(event.Context, event.SessionID, event.Pipeline.Name, event.RunID)

	if runID, ok := state.CurrentRunByLoop[key]; ok {
		if _, running := state.Runs[runID]; running {
			// An active run is already in flight for this loop; the driver must
			// cancel it (NEW_SHA_DETECTED or RUN_CANCELLED) before a new run
			// can start.
			return state, nil
		}
	}

	// Same-SHA dedup: a non-manual trigger that already ran this exact SHA to a
	// settled outcome (completed or stalled) must not spawn an identical run.
	// This absorbs CI flapping (pass -> fail -> pass on one SHA re-firing
	// merge_ready) and fact-only pr.updated churn. Manual triggers always fire:
	// a human explicitly asked, even at an already-run SHA.
	if event.Trigger != TriggerManual && event.HeadSHA != "" {
		for _, s := range state.HistorySummaries[key] {
			if s.HeadSHA == event.HeadSHA && isSettledRun(s) {
				return state, []Effect{EmitObservation{
					Name: "pipeline.run.trigger_deduped",
					Data: map[string]any{
						"pipelineName": event.Pipeline.Name,
						"sessionId":    event.SessionID,
						"trigger":      event.Trigger,
						"headSha":      event.HeadSHA,
						"priorRunId":   s.RunID,
					},
				}}
			}
		}
	}

	stages, ok := buildInitialStageStates(event.Pipeline, event.StageRunIDs)
	if !ok {
		return invalidTransition(state, "TRIGGER_FIRED missing stageRunIds for one or more stages")
	}

	// Only settled runs (completed or stalled) count as loop rounds; runs cut
	// short (outdated, cancelled, config change) must not trip loop_rounds_at_least.
	priorRound := 0
	for _, s := range state.HistorySummaries[key] {
		if isSettledRun(s) {
			priorRound++
		}
	}
	isContinuation := event.Trigger == TriggerPRUpdated || event.Trigger == TriggerManual
	loopRounds := priorRound
	if isContinuation {
		loopRounds = priorRound + 1
	} else if loopRounds < 1 {
		loopRounds = 1
	}

	initialRun := RunState{
		RunID:                  event.RunID,
		PipelineID:             event.Pipeline.ID,
		PipelineName:           event.Pipeline.Name,
		SessionID:              event.SessionID,
		PipelineConfigSnapshot: event.Pipeline,
		HeadSHA:                event.HeadSHA,
		Context:                event.Context,
		LoopState:              LoopRunning,
		LoopRounds:             loopRounds,
		Stages:                 stages,
		CreatedAt:              now,
		UpdatedAt:              now,
	}

	// Run the DAG scheduler once at trigger time so vacuous routes get a single
	// skip decision instead of sitting pending forever, and parallel-startable
	// stages emit START_STAGE in one shot.
	sched := scheduleAfterChange(initialRun, now)
	runState := sched.run

	createdObs := EmitObservation{
		Name: "pipeline.run.created",
		Data: map[string]any{
			"runId":        event.RunID,
			"pipelineName": event.Pipeline.Name,
			"sessionId":    event.SessionID,
			"trigger":      event.Trigger,
			"headSha":      event.HeadSHA,
			"loopRounds":   loopRounds,
		},
	}

	// Cascade-skipping into a fully-terminal pipeline at trigger time is only
	// possible with degenerate predicates. Terminate cleanly rather than
	// leaving an orphaned record.
	if sched.allTerminal {
		stateWithRun := replaceRun(state, runState)
		stateWithRun = withCurrentRun(stateWithRun, key, event.RunID)
		preceding := append([]Effect{createdObs}, skipObservations(runState.RunID, sched.newlySkipped, runState)...)
		preceding = append(preceding, roundCappedObservations(runState.RunID, sched.roundCappedSkips, runState)...)
		decision := decideRunExit(runState, stateWithRun)
		return terminateRunFromState(stateWithRun, runState, decision.reason, now, decision.loopState, preceding)
	}

	nextState := replaceRun(state, runState)
	nextState = withCurrentRun(nextState, key, event.RunID)

	effects := make([]Effect, 0, 3+len(sched.startEffects)+len(sched.newlySkipped))
	effects = append(effects,
		PersistRun{RunState: runState},
		PersistLoopState{RunID: event.RunID, LoopState: deriveLoopStateFromRun(runState, now)},
	)
	effects = append(effects, sched.startEffects...)
	effects = append(effects, createdObs)
	effects = append(effects, skipObservations(runState.RunID, sched.newlySkipped, runState)...)
	effects = append(effects, roundCappedObservations(runState.RunID, sched.roundCappedSkips, runState)...)

	return nextState, effects
}

// withCurrentRun returns a copy of state with key pointing at runID in
// CurrentRunByLoop (copy-on-write).
func withCurrentRun(state EngineState, key string, runID RunID) EngineState {
	current := make(map[string]RunID, len(state.CurrentRunByLoop)+1)
	for k, v := range state.CurrentRunByLoop {
		current[k] = v
	}
	current[key] = runID
	state.CurrentRunByLoop = current
	return state
}

// skipObservations builds pipeline.stage.terminated observations for stages the
// DAG scheduler just skipped, mirroring the shape emitted by
// finalizeStageCompletion so consumers need no per-source schema.
func skipObservations(runID RunID, skippedNames []string, run RunState) []Effect {
	out := make([]Effect, 0, len(skippedNames))
	for _, name := range skippedNames {
		artifactCount := 0
		if s, ok := run.Stages[name]; ok {
			artifactCount = len(s.Artifacts)
		}
		out = append(out, EmitObservation{
			Name: "pipeline.stage.terminated",
			Data: map[string]any{
				"runId":         runID,
				"stageName":     name,
				"status":        StageStatusSkipped,
				"artifactCount": artifactCount,
			},
		})
	}
	return out
}

func reduceStageStarted(state EngineState, event StageStarted) (EngineState, []Effect) {
	now := event.Now
	run, ok := state.Runs[event.RunID]
	if !ok {
		return invalidTransition(state, "STAGE_STARTED for unknown runId="+string(event.RunID))
	}
	stage, ok := run.Stages[event.StageName]
	if !ok {
		return invalidTransition(state, "STAGE_STARTED for unknown stage="+event.StageName)
	}
	if stage.Status != StageStatusPending {
		return invalidTransition(state, "STAGE_STARTED requires pending; got "+string(stage.Status)+" for "+event.StageName)
	}

	started := now
	updatedStage := stage
	updatedStage.Status = StageStatusRunning
	updatedStage.StartedAt = &started
	deadline := started.Add(stageTimeout(run.PipelineConfigSnapshot, event.StageName))
	updatedStage.Deadline = &deadline
	updatedRun := patchRun(run, map[string]StageState{event.StageName: updatedStage}, now)

	return replaceRun(state, updatedRun), []Effect{
		PersistRun{RunState: updatedRun},
		EmitObservation{
			Name: "pipeline.stage.started",
			// stageRunId rotates on every retry/revival, so it is the only
			// field that uniquely identifies this execution: attempt is not
			// enough now that outdated revival keeps the counter unchanged.
			Data: map[string]any{
				"runId":      event.RunID,
				"stageName":  event.StageName,
				"stageRunId": stage.StageRunID,
				"attempt":    stage.Attempt,
			},
		},
	}
}

func reduceStageCompleted(state EngineState, event StageCompleted) (EngineState, []Effect) {
	now := event.Now
	run, ok := state.Runs[event.RunID]
	if !ok {
		return invalidTransition(state, "STAGE_COMPLETED for unknown runId="+string(event.RunID))
	}
	stage, ok := run.Stages[event.StageName]
	if !ok {
		return invalidTransition(state, "STAGE_COMPLETED for unknown stage="+event.StageName)
	}
	if stage.Status != StageStatusRunning {
		return invalidTransition(state, "STAGE_COMPLETED requires running; got "+string(stage.Status)+" for "+event.StageName)
	}

	newArtifacts := make([]Artifact, len(event.Artifacts))
	newIDs := make([]ArtifactID, len(event.Artifacts))
	for idx, input := range event.Artifacts {
		a := materializeArtifact(input, event.RunID, stage.StageRunID, event.StageName, idx, now)
		newArtifacts[idx] = a
		newIDs[idx] = a.ArtifactID
	}

	completed := now
	updatedStage := stage
	updatedStage.Status = StageStatusSucceeded
	updatedStage.CompletedAt = &completed
	updatedStage.Verdict = event.Verdict
	updatedStage.Output = event.Output
	if event.SessionID != "" {
		updatedStage.SessionID = event.SessionID
	}
	updatedStage.Notes = capStageNotes(append(append([]string{}, stage.Notes...), event.Notes...))
	updatedStage.Artifacts = append(append([]ArtifactID{}, stage.Artifacts...), newIDs...)

	return finalizeStageCompletion(state, run, event.StageName, updatedStage, newArtifacts, event.StatusChanges, now)
}

func reduceStageFailed(state EngineState, event StageFailed) (EngineState, []Effect) {
	now := event.Now
	run, ok := state.Runs[event.RunID]
	if !ok {
		return invalidTransition(state, "STAGE_FAILED for unknown runId="+string(event.RunID))
	}
	stage, ok := run.Stages[event.StageName]
	if !ok {
		return invalidTransition(state, "STAGE_FAILED for unknown stage="+event.StageName)
	}
	if stage.Status != StageStatusRunning && stage.Status != StageStatusPending {
		return invalidTransition(state, "STAGE_FAILED requires running|pending; got "+string(stage.Status)+" for "+event.StageName)
	}

	return failStage(state, run, event.StageName, event.ErrorMessage, event.Output, event.SessionID, event.Notes, now, false)
}

// failStage applies a stage failure with automatic retry. When the stage still
// has retry budget (its attempt is within Stage.Retries; retries: 2 allows up to
// 3 attempts total, mirroring reducer_resume's cap), it re-pends the stage with
// a fresh stageRunId and attempt+1 and lets the scheduler start it again;
// otherwise it finalizes the stage as failed. cancel emits a CANCEL_STAGE effect
// first: the TICK timeout path fails a stage whose executor handle is still
// live, so the engine must tear it down.
func failStage(state EngineState, run RunState, stageName, errorMessage, output, sessionID string, notes []string, now time.Time, cancel bool) (EngineState, []Effect) {
	stage := run.Stages[stageName]

	var preceding []Effect
	if cancel {
		preceding = []Effect{CancelStage{
			RunID:      run.RunID,
			StageRunID: stage.StageRunID,
			StageName:  stageName,
		}}
	}

	if retries := stageRetries(run.PipelineConfigSnapshot, stageName); retries != nil && stage.Attempt <= *retries {
		return retryStage(state, run, stageName, stage, errorMessage, now, preceding)
	}

	completed := now
	updatedStage := stage
	updatedStage.Status = StageStatusFailed
	updatedStage.CompletedAt = &completed
	updatedStage.ErrorMessage = errorMessage
	updatedStage.Output = output
	if sessionID != "" {
		updatedStage.SessionID = sessionID
	}
	updatedStage.Notes = capStageNotes(append(append([]string{}, stage.Notes...), notes...))
	updatedStage.Deadline = nil

	return finalizeStageCompletion(state, run, stageName, updatedStage, nil, nil, now, preceding...)
}

// retryStage re-pends a failed stage for another attempt (fresh stageRunId,
// attempt+1) and re-runs the scheduler so it starts again. A retry never
// terminates the run on its own, but if the re-pended stage cannot actually run
// (e.g. it is now past its maxLoopRounds cap and immediately re-skips, leaving
// every stage terminal) the run terminates honestly rather than wedging.
func retryStage(state EngineState, run RunState, stageName string, stage StageState, errorMessage string, now time.Time, preceding []Effect) (EngineState, []Effect) {
	nextAttempt := stage.Attempt + 1
	repended := StageState{
		StageRunID: nextStageRunID(stage.StageRunID, nextAttempt),
		Status:     StageStatusPending,
		Attempt:    nextAttempt,
	}
	updatedRun := patchRun(run, map[string]StageState{stageName: repended}, now)

	retryObs := EmitObservation{
		Name: "pipeline.stage.retried",
		Data: map[string]any{
			"runId":      run.RunID,
			"stageName":  stageName,
			"stageRunId": repended.StageRunID,
			"attempt":    nextAttempt,
			"error":      errorMessage,
		},
	}

	sched := scheduleAfterChange(updatedRun, now)
	skipObs := skipObservations(run.RunID, sched.newlySkipped, sched.run)
	roundObs := roundCappedObservations(run.RunID, sched.roundCappedSkips, sched.run)

	if sched.allTerminal {
		preceding2 := make([]Effect, 0, len(preceding)+1+len(skipObs)+len(roundObs))
		preceding2 = append(preceding2, preceding...)
		preceding2 = append(preceding2, retryObs)
		preceding2 = append(preceding2, skipObs...)
		preceding2 = append(preceding2, roundObs...)
		base := replaceRun(state, sched.run)
		if isConverged(state, sched.run) {
			return terminateRunFromState(base, sched.run, TerminationConverged, now, LoopStalled, preceding2)
		}
		decision := decideRunExit(sched.run, state)
		return terminateRunFromState(base, sched.run, decision.reason, now, decision.loopState, preceding2)
	}

	out := make([]Effect, 0, len(preceding)+2+len(sched.startEffects)+len(skipObs)+len(roundObs))
	out = append(out, preceding...)
	out = append(out, PersistRun{RunState: sched.run}, retryObs)
	out = append(out, sched.startEffects...)
	out = append(out, skipObs...)
	out = append(out, roundObs...)
	return replaceRun(state, sched.run), out
}

// reduceTick fails every running stage whose deadline has passed as of
// event.Now, one at a time so each failure's retry/finalize cascade is applied
// before the next expired stage is chosen. Pure: the deadline comparison uses
// only event.Now. Bounded: each step turns a running stage into pending (retry)
// or terminal (finalize), so the past-deadline running set strictly shrinks.
func reduceTick(state EngineState, event Tick) (EngineState, []Effect) {
	now := event.Now
	var effects []Effect
	for {
		runID, stageName, ok := nextExpiredStage(state, now)
		if !ok {
			break
		}
		run := state.Runs[runID]
		message := timeoutMessage(run.Stages[stageName])
		var step []Effect
		state, step = failStage(state, run, stageName, message, "", "", nil, now, true)
		effects = append(effects, step...)
	}
	return state, effects
}

// nextExpiredStage returns the first running stage (ordered by runId then stage
// name) whose deadline has passed as of now, or ok=false when none have. The
// deterministic ordering keeps tick effects reproducible.
func nextExpiredStage(state EngineState, now time.Time) (RunID, string, bool) {
	runIDs := make([]RunID, 0, len(state.Runs))
	for id := range state.Runs {
		runIDs = append(runIDs, id)
	}
	sort.Slice(runIDs, func(i, j int) bool { return runIDs[i] < runIDs[j] })
	for _, id := range runIDs {
		run := state.Runs[id]
		if run.LoopState.IsTerminal() {
			continue
		}
		names := make([]string, 0, len(run.Stages))
		for name := range run.Stages {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			s := run.Stages[name]
			if s.Status == StageStatusRunning && s.Deadline != nil && now.After(*s.Deadline) {
				return id, name, true
			}
		}
	}
	return "", "", false
}

// timeoutMessage renders the failure message for a deadline-expired stage.
func timeoutMessage(stage StageState) string {
	if stage.Deadline != nil && stage.StartedAt != nil {
		return fmt.Sprintf("stage timed out after %s (deadline exceeded)", stage.Deadline.Sub(*stage.StartedAt))
	}
	return "stage timed out (deadline exceeded)"
}

// stageTimeout returns the running-deadline offset for stage: its configured
// TimeoutMs when positive, else DefaultStageTimeout.
func stageTimeout(p Pipeline, stageName string) time.Duration {
	if def, ok := findStageDef(p, stageName); ok && def.TimeoutMs != nil && *def.TimeoutMs > 0 {
		return time.Duration(*def.TimeoutMs) * time.Millisecond
	}
	return DefaultStageTimeout
}

// stageRetries returns the configured retry budget for stage (nil when unset).
func stageRetries(p Pipeline, stageName string) *int {
	if def, ok := findStageDef(p, stageName); ok {
		return def.Retries
	}
	return nil
}

// findStageDef looks a stage definition up by name in the run's config snapshot.
func findStageDef(p Pipeline, stageName string) (Stage, bool) {
	for i := range p.Stages {
		if p.Stages[i].Name == stageName {
			return p.Stages[i], true
		}
	}
	return Stage{}, false
}

// nextStageRunID derives a fresh, deterministic stageRunId for an automatic
// retry. The reducer is pure and cannot allocate uuids (manual resume gets
// driver-allocated ids), so a retry suffixes the base id with the new attempt
// number. Per-attempt uniqueness is what matters, since artifact ids embed the
// stageRunId; the base is stripped of any prior "#N" suffix so repeated retries
// stay "<base>#2", "<base>#3", and so on.
func nextStageRunID(current StageRunID, attempt int) StageRunID {
	base := string(current)
	if i := strings.LastIndex(base, "#"); i >= 0 {
		base = base[:i]
	}
	return StageRunID(fmt.Sprintf("%s#%d", base, attempt))
}

// roundCappedObservations builds pipeline.stage.skipped_max_rounds observations
// for stages the scheduler skipped because the run's loop round exceeded their
// per-stage maxLoopRounds cap.
func roundCappedObservations(runID RunID, skippedNames []string, run RunState) []Effect {
	out := make([]Effect, 0, len(skippedNames))
	for _, name := range skippedNames {
		data := map[string]any{
			"runId":      runID,
			"stageName":  name,
			"loopRounds": run.LoopRounds,
		}
		if def, ok := findStageDef(run.PipelineConfigSnapshot, name); ok && def.MaxLoopRounds != nil {
			data["maxLoopRounds"] = *def.MaxLoopRounds
		}
		out = append(out, EmitObservation{Name: "pipeline.stage.skipped_max_rounds", Data: data})
	}
	return out
}

// finalizeStageCompletion applies a stage's terminal status, materializes its
// artifacts and fingerprints, re-runs the DAG scheduler for downstream stages,
// and terminates the run (checking convergence then exit predicates) once every
// stage is terminal. Shared by STAGE_COMPLETED and STAGE_FAILED. preceding
// effects (e.g. a CANCEL_STAGE for a timed-out stage) are emitted first.
func finalizeStageCompletion(state EngineState, run RunState, stageName string, updatedStage StageState, newArtifacts []Artifact, statusChanges []FindingStatusChange, now time.Time, preceding ...Effect) (EngineState, []Effect) {
	// Accumulate finding fingerprints onto the run so summarizeRun can return
	// them at termination. Append rather than recompute so the reducer never
	// re-reads stored artifacts.
	var newFingerprints []string
	var newFindings []Artifact
	for i := range newArtifacts {
		a := newArtifacts[i]
		if a.Kind == ArtifactKindFinding {
			if a.Fingerprint != "" {
				newFingerprints = append(newFingerprints, a.Fingerprint)
			}
			newFindings = append(newFindings, a)
		}
	}

	runWithFingerprints := run
	if len(newFingerprints) > 0 {
		runWithFingerprints.Fingerprints = append(append([]string{}, run.Fingerprints...), newFingerprints...)
	}
	updatedRun := patchRun(runWithFingerprints, map[string]StageState{stageName: updatedStage}, now)
	// Mirror finding artifacts onto run.findings for the predicate evaluator.
	if len(newFindings) > 0 {
		updatedRun.Findings = append(append([]Artifact{}, run.Findings...), newFindings...)
	}

	effects := append([]Effect{}, preceding...)

	if len(newArtifacts) > 0 {
		effects = append(effects, AppendArtifacts{
			RunID:      run.RunID,
			StageRunID: updatedStage.StageRunID,
			Artifacts:  newArtifacts,
		})
	}

	// Apply this stage's {kind:"status"} records BEFORE scheduling and the exit
	// decision, so a verify stage resolving (or reopening) a finding actually
	// changes whether no_open_findings holds. Runs after the AppendArtifacts effect
	// so the UPDATE lands on an already-persisted row when the record targets a
	// finding this same stage just emitted.
	if len(statusChanges) > 0 {
		var statusEffects []Effect
		var statusNotes []string
		updatedRun, statusEffects, statusNotes = applyFindingStatusChanges(updatedRun, statusChanges)
		effects = append(effects, statusEffects...)
		// Surface unknown-fingerprint status records as stage notes: a verify stage
		// referencing a fingerprint no finding in this run carries is otherwise a
		// silent no-op. Append onto the stage the record belongs to.
		if len(statusNotes) > 0 {
			st := updatedRun.Stages[stageName]
			st.Notes = capStageNotes(append(append([]string{}, st.Notes...), statusNotes...))
			updatedRun = patchRun(updatedRun, map[string]StageState{stageName: st}, now)
		}
	}

	effects = append(effects, EmitObservation{
		Name: "pipeline.stage.terminated",
		Data: map[string]any{
			"runId":         run.RunID,
			"stageName":     stageName,
			"status":        updatedStage.Status,
			"verdict":       updatedStage.Verdict,
			"artifactCount": len(updatedStage.Artifacts),
		},
	})

	// Failure-tolerant scheduling: STAGE_FAILED no longer immediately
	// terminates the run. scheduleAfterChange cascade-skips stages whose
	// dependsOn is no longer satisfiable AND starts any recovery branch whose
	// routes predicate now matches the failure. The run terminates only once
	// every stage is terminal.
	sched := scheduleAfterChange(updatedRun, now)
	effects = append(effects, skipObservations(run.RunID, sched.newlySkipped, sched.run)...)
	effects = append(effects, roundCappedObservations(run.RunID, sched.roundCappedSkips, sched.run)...)

	if sched.allTerminal {
		// Convergence detection runs BEFORE the regular exit decision: when the
		// prior stallWindow-1 runs plus this one expose the same finding
		// fingerprint set, terminate as converged -> stalled so a loop that hit
		// a fixpoint doesn't ping-pong forever.
		if isConverged(state, sched.run) {
			return terminateRunFromState(replaceRun(state, sched.run), sched.run, TerminationConverged, now, LoopStalled, effects)
		}
		decision := decideRunExit(sched.run, state)
		return terminateRunFromState(replaceRun(state, sched.run), sched.run, decision.reason, now, decision.loopState, effects)
	}

	// Not terminal: persist first, then start eligible stages.
	out := make([]Effect, 0, len(effects)+1+len(sched.startEffects))
	out = append(out, PersistRun{RunState: sched.run})
	out = append(out, effects...)
	out = append(out, sched.startEffects...)

	return replaceRun(state, sched.run), out
}

// applyFindingStatusChanges flips the status of every finding in run.Findings
// whose fingerprint matches a status change, returning the updated run plus one
// UpdateArtifactStatus effect per applied flip (so the store stays in sync). A
// fingerprint that matches no finding is tolerated: it yields a
// pipeline.status.unknown_fingerprint observation, never a failure. Pure and
// copy-on-write: run.Findings is not mutated in place.
func applyFindingStatusChanges(run RunState, changes []FindingStatusChange) (RunState, []Effect, []string) {
	findings := append([]Artifact{}, run.Findings...)
	var effects []Effect
	var notes []string
	for _, ch := range changes {
		matched := false
		for i := range findings {
			if findings[i].Fingerprint != "" && findings[i].Fingerprint == ch.Fingerprint {
				matched = true
				findings[i].Status = ch.Status
				effects = append(effects, UpdateArtifactStatus{
					RunID:      run.RunID,
					StageRunID: findings[i].StageRunID,
					ArtifactID: findings[i].ArtifactID,
					Status:     ch.Status,
				})
			}
		}
		if !matched {
			effects = append(effects, EmitObservation{
				Name: "pipeline.status.unknown_fingerprint",
				Data: map[string]any{
					"runId":       run.RunID,
					"fingerprint": ch.Fingerprint,
					"status":      ch.Status,
				},
			})
			notes = append(notes, fmt.Sprintf("status record (%s) targeted fingerprint %s, which matches no finding in this run; ignored", ch.Status, shortFingerprint(ch.Fingerprint)))
		}
	}
	run.Findings = findings
	return run, effects, notes
}

// shortFingerprint trims a finding fingerprint to a readable prefix for a note.
func shortFingerprint(fp string) string {
	if len(fp) > 12 {
		return fp[:12] + "..."
	}
	return fp
}

// capStageNotes bounds a stage's note list to MaxStageNotes, keeping the most
// recent lines (drop oldest first) so a long-running loop's stage cannot grow it
// without limit.
func capStageNotes(notes []string) []string {
	if len(notes) <= MaxStageNotes {
		return notes
	}
	return notes[len(notes)-MaxStageNotes:]
}

func reduceNewSHADetected(state EngineState, event NewSHADetected) (EngineState, []Effect) {
	// Look up by the PR-scoped loop key so a SHA change on one PR only reaches
	// that PR's run, never a sibling PR's run on the same session+pipeline.
	key := LoopKeyFor(RunContext{PRURL: event.PRURL}, event.SessionID, event.PipelineName, "")
	runID, ok := state.CurrentRunByLoop[key]
	if !ok {
		return state, nil
	}
	run, ok := state.Runs[runID]
	if !ok || run.HeadSHA == event.SHA {
		return state, nil
	}
	// Defensive guard: never terminate a run whose PR does not match the one
	// whose SHA changed. The key already encodes the PR, so this only bites if a
	// key ever aliased.
	if event.PRURL != "" && run.Context.PRURL != event.PRURL {
		return state, nil
	}
	// Run becomes outdated; the loop key is freed so the driver can spawn a new
	// TRIGGER_FIRED for the new SHA.
	return terminateRun(state, run, TerminationOutdated, event.Now, LoopTerminated)
}

func reduceRunCancelled(state EngineState, event RunCancelled) (EngineState, []Effect) {
	run, ok := state.Runs[event.RunID]
	if !ok {
		return invalidTransition(state, "RUN_CANCELLED for unknown runId="+string(event.RunID))
	}
	if run.LoopState != LoopRunning && run.LoopState != LoopAwaitingContext {
		return invalidTransition(state, "RUN_CANCELLED requires running|awaiting_context; got "+string(run.LoopState))
	}
	finalState := LoopTerminated
	if event.Reason == TerminationStageFailure {
		finalState = LoopStalled
	}
	return terminateRun(state, run, event.Reason, event.Now, finalState)
}

func reduceConfigChanged(state EngineState, event ConfigChanged) (EngineState, []Effect) {
	// The config changed for a whole session+pipeline, but per-PR loop keys mean
	// several runs (one per PR, plus any manual) may be in flight for it. Every
	// run is pinned to the now-stale config snapshot, so terminate them all.
	// Collect matching non-terminal runs and terminate in RunID order for
	// deterministic effects.
	runIDs := make([]RunID, 0, len(state.Runs))
	for id, run := range state.Runs {
		if run.SessionID == event.SessionID && run.PipelineName == event.PipelineName && !run.LoopState.IsTerminal() {
			runIDs = append(runIDs, id)
		}
	}
	if len(runIDs) == 0 {
		return state, nil
	}
	sort.Slice(runIDs, func(i, j int) bool { return runIDs[i] < runIDs[j] })

	var effects []Effect
	for _, id := range runIDs {
		run, ok := state.Runs[id]
		if !ok || run.LoopState.IsTerminal() {
			continue
		}
		var eff []Effect
		state, eff = terminateRun(state, run, TerminationConfigChange, event.Now, LoopTerminated)
		effects = append(effects, eff...)
	}
	return state, effects
}

func reduceArtifactStatusChanged(state EngineState, event ArtifactStatusChanged) (EngineState, []Effect) {
	now := event.Now
	run, ok := state.Runs[event.RunID]
	if !ok {
		return invalidTransition(state, "ARTIFACT_STATUS_CHANGED for unknown runId="+string(event.RunID))
	}

	updatedRun := run
	idx := -1
	for i := range run.Findings {
		if run.Findings[i].ArtifactID == event.ArtifactID {
			idx = i
			break
		}
	}
	if idx >= 0 {
		findings := append([]Artifact{}, run.Findings...)
		findings[idx].Status = event.Status
		updatedRun.Findings = findings
	}
	updatedRun.UpdatedAt = now

	effects := []Effect{
		UpdateArtifactStatus{
			RunID:      event.RunID,
			StageRunID: event.StageRunID,
			ArtifactID: event.ArtifactID,
			Status:     event.Status,
		},
		PersistRun{RunState: updatedRun},
		EmitObservation{
			Name: "pipeline.artifact.status_changed",
			Data: artifactStatusObsData(event),
		},
	}
	return replaceRun(state, updatedRun), effects
}

func artifactStatusObsData(event ArtifactStatusChanged) map[string]any {
	data := map[string]any{
		"runId":      event.RunID,
		"stageRunId": event.StageRunID,
		"artifactId": event.ArtifactID,
		"status":     event.Status,
	}
	if event.Actor != "" {
		data["actor"] = event.Actor
	}
	return data
}

// buildInitialStageStates seeds one pending StageState per pipeline stage using
// the driver-allocated stageRunIds. Returns false when any stage lacks an id.
func buildInitialStageStates(pipeline Pipeline, stageRunIDs map[string]StageRunID) (map[string]StageState, bool) {
	out := make(map[string]StageState, len(pipeline.Stages))
	for _, stage := range pipeline.Stages {
		id, ok := stageRunIDs[stage.Name]
		if !ok || id == "" {
			return nil, false
		}
		out[stage.Name] = StageState{
			StageRunID: id,
			Status:     StageStatusPending,
			Attempt:    1,
		}
	}
	return out, true
}

type exitDecision struct {
	reason    RunTerminationReason
	loopState LoopStateName
}

// decideRunExit chooses how a run terminates once every stage is terminal, and
// is honest about unmet exit predicates: it never reports a run completed while
// its configured `done` predicate is false.
//
//  1. No exit predicates configured at all -> v0 default (any failed stage ->
//     stalled/stage_failure, else done/completed).
//  2. exitPredicates.done true -> done/completed.
//  3. exitPredicates.stalled true -> stalled/stage_failure.
//  4. done configured but false (and stalled, if any, did not fire) -> stalled
//     with a distinct "done predicate unmet" reason, never completed.
//  5. only stalled configured and it did not fire -> v0 default (no `done` gate,
//     so there is no unmet-completion condition to guard).
//
// The reducer consults state.HistorySummaries for the run's loop key so
// loop_rounds_at_least and history-aware composites have a real ledger.
func decideRunExit(run RunState, state EngineState) exitDecision {
	exits := run.PipelineConfigSnapshot.ExitPredicates
	if exits == nil || (exits.Done == nil && exits.Stalled == nil) {
		return v0DefaultExitDecision(run)
	}

	ctx := PredicateCtx{
		Run:      &run,
		History:  state.HistorySummaries[LoopKeyFor(run.Context, run.SessionID, run.PipelineName, run.RunID)],
		Findings: run.Findings,
	}

	if exits.Done != nil && Evaluate(*exits.Done, ctx) {
		return exitDecision{reason: TerminationCompleted, loopState: LoopDone}
	}
	if exits.Stalled != nil && Evaluate(*exits.Stalled, ctx) {
		return exitDecision{reason: TerminationStageFailure, loopState: LoopStalled}
	}
	if exits.Done != nil {
		// `done` was configured and evaluated false: the run did not meet its
		// success condition (e.g. open findings remain). Terminate as stalled so
		// the loop can be resumed for another round, never as completed.
		return exitDecision{reason: TerminationDonePredicateUnmet, loopState: LoopStalled}
	}
	return v0DefaultExitDecision(run)
}

func v0DefaultExitDecision(run RunState) exitDecision {
	for _, s := range run.Stages {
		if s.Status == StageStatusFailed {
			return exitDecision{reason: TerminationStageFailure, loopState: LoopStalled}
		}
	}
	return exitDecision{reason: TerminationCompleted, loopState: LoopDone}
}

// isConverged reports whether the prior stallWindow-1 history summaries on this
// loop plus the just-completed run all expose the same sorted-unique finding
// fingerprint set. stallWindow is per-stage; the max across stages with the
// policy set is used, and any stage with stallWindow >= 2 activates the check.
// A window of 0 or 1 is meaningless (need at least two runs to detect
// repetition) and disables the check.
func isConverged(state EngineState, run RunState) bool {
	window := 0
	for _, stage := range run.PipelineConfigSnapshot.Stages {
		if stage.Policy != nil && stage.Policy.StallWindow != nil && *stage.Policy.StallWindow > window {
			window = *stage.Policy.StallWindow
		}
	}
	if window < 2 {
		return false
	}

	history := state.HistorySummaries[LoopKeyFor(run.Context, run.SessionID, run.PipelineName, run.RunID)]
	if len(history) < window-1 {
		return false
	}

	current := joinSortedUnique(run.Fingerprints)
	recent := history[len(history)-(window-1):]
	for i := range recent {
		if joinSortedUnique(recent[i].Fingerprints) != current {
			return false
		}
	}
	return true
}

// joinSortedUnique renders a fingerprint set as a stable comparison key.
func joinSortedUnique(in []string) string {
	unique := sortedUnique(in)
	out := ""
	for i, s := range unique {
		if i > 0 {
			out += "|"
		}
		out += s
	}
	return out
}
