package pipeline

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

// Internal helpers for the pipeline reducer.
//
// Pure: every function takes the driver-stamped clock as a parameter; nothing
// here reads the clock or performs I/O. Ported from the old TypeScript
// reducer-helpers.ts.

// patchRun returns a copy of run with stageDelta merged into its stages map
// and UpdatedAt bumped. The input run's map is never mutated.
func patchRun(run RunState, stageDelta map[string]StageState, now time.Time) RunState {
	stages := make(map[string]StageState, len(run.Stages)+len(stageDelta))
	for k, v := range run.Stages {
		stages[k] = v
	}
	for k, v := range stageDelta {
		stages[k] = v
	}
	run.Stages = stages
	run.UpdatedAt = now
	return run
}

// replaceRun returns a copy of state with run stored under its RunID. The
// input state's runs map is never mutated.
func replaceRun(state EngineState, run RunState) EngineState {
	runs := make(map[RunID]RunState, len(state.Runs))
	for k, v := range state.Runs {
		runs[k] = v
	}
	runs[run.RunID] = run
	state.Runs = runs
	return state
}

// deriveLoopStateFromRun projects a run onto its persistent LoopState record.
// CurrentRunID is cleared once the run reaches a terminal loop state so the
// driver can spawn a fresh run for the loop key.
func deriveLoopStateFromRun(run RunState, now time.Time) LoopState {
	current := run.RunID
	if run.LoopState.IsTerminal() {
		current = ""
	}
	return LoopState{
		SessionID:    run.SessionID,
		PipelineName: run.PipelineName,
		LoopState:    run.LoopState,
		LoopRounds:   run.LoopRounds,
		LastSHA:      run.HeadSHA,
		CurrentRunID: current,
		UpdatedAt:    now,
	}
}

// summarizeRun builds the compact cross-run history record. Fingerprints are
// deduped and sorted so summaries are comparable across runs regardless of
// discovery order.
func summarizeRun(run RunState) RunSummary {
	return RunSummary{
		RunID:             run.RunID,
		LoopState:         run.LoopState,
		TerminationReason: run.TerminationReason,
		HeadSHA:           run.HeadSHA,
		LoopRounds:        run.LoopRounds,
		Fingerprints:      sortedUnique(run.Fingerprints),
		CreatedAt:         run.CreatedAt,
	}
}

// isSettledRun reports whether a run summary reached a real conclusion (loop
// state done or stalled) rather than being cut short (outdated, cancelled, or
// config change, all of which land in loop state terminated). Only settled runs
// count toward the loop round counter and toward same-SHA trigger dedup.
func isSettledRun(s RunSummary) bool {
	return s.LoopState == LoopDone || s.LoopState == LoopStalled
}

// sortedUnique returns the deduped, ascending-sorted copy of in. It always
// returns a non-nil slice so JSON round-trips as [] rather than null, matching
// the old TypeScript summaries.
func sortedUnique(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// materializeArtifact promotes a stage-reported ArtifactInput into a persisted
// Artifact, assigning the engine envelope (id, run/stage identity, open status,
// createdAt) and, for findings, a stable fingerprint.
func materializeArtifact(input ArtifactInput, runID RunID, stageRunID StageRunID, stageName string, index int, now time.Time) Artifact {
	a := Artifact{
		ArtifactInput: input,
		ArtifactID:    ArtifactID(fmt.Sprintf("%s-%d", stageRunID, index)),
		PipelineRunID: runID,
		StageRunID:    stageRunID,
		StageName:     stageName,
		Status:        ArtifactStatusOpen,
		CreatedAt:     now,
	}
	// Finding artifacts carry a stable fingerprint computed from the stage name
	// + structural identity (filePath, anchor, category, title). This is what
	// lets dismissals match across runs and drives stallWindow convergence
	// detection.
	if input.Kind == ArtifactKindFinding {
		a.Fingerprint = computeFindingFingerprint(input, stageName)
	}
	return a
}

// computeFindingFingerprint hashes a finding's stage-scoped structural
// identity. Ported verbatim from the old migrate.ts computeFindingFingerprint
// (that file is otherwise dropped as greenfield): the anchor falls back to the
// line range when no structural anchor signature is present, and the joined
// parts are sha256'd and truncated to 16 hex chars.
func computeFindingFingerprint(input ArtifactInput, stageName string) string {
	anchor := input.AnchorSignature
	if anchor == "" {
		anchor = fmt.Sprintf("L%d:%d", input.StartLine, input.EndLine)
	}
	joined := stageName + "\x00" + input.FilePath + "\x00" + anchor + "\x00" + input.Category + "\x00" + input.Title
	sum := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(sum[:])[:16]
}

// invalidTransition emits a single observation describing a rejected event and
// leaves state untouched. Invalid events are logged, never fatal.
func invalidTransition(state EngineState, message string) (EngineState, []Effect) {
	return state, []Effect{
		EmitObservation{
			Name: "pipeline.invalid_transition",
			Data: map[string]any{"message": message},
		},
	}
}

// terminateRunFromState terminates run with the given reason and final loop
// state: non-terminal stages become outdated (if running) or skipped (if not),
// running stages emit CANCEL_STAGE, the run is summarized into history, and the
// loop key is freed when this run owned it. preceding effects are emitted ahead
// of the cancel/persist/observation effects.
func terminateRunFromState(state EngineState, run RunState, reason RunTerminationReason, now time.Time, finalLoopState LoopStateName, preceding []Effect) (EngineState, []Effect) {
	var cancelEffects []Effect
	terminatedStages := make(map[string]StageState, len(run.Stages))
	for name, stage := range run.Stages {
		if !stage.Status.IsTerminal() {
			completed := now
			next := stage
			if stage.Status == StageStatusRunning {
				next.Status = StageStatusOutdated
			} else {
				next.Status = StageStatusSkipped
			}
			next.CompletedAt = &completed
			terminatedStages[name] = next
			if stage.Status == StageStatusRunning {
				cancelEffects = append(cancelEffects, CancelStage{
					RunID:      run.RunID,
					StageRunID: stage.StageRunID,
					StageName:  name,
				})
			}
		} else {
			terminatedStages[name] = stage
		}
	}

	finalRun := run
	finalRun.Stages = terminatedStages
	finalRun.LoopState = finalLoopState
	finalRun.TerminationReason = reason
	finalRun.BlocksMerge = runBlocksMerge(state, run, reason)
	finalRun.UpdatedAt = now

	key := LoopKeyFor(run.Context, run.SessionID, run.PipelineName, run.RunID)

	// Append this run's summary to the loop's history (copy-on-write).
	prior := state.HistorySummaries[key]
	summaries := make([]RunSummary, len(prior), len(prior)+1)
	copy(summaries, prior)
	summaries = append(summaries, summarizeRun(finalRun))

	histories := make(map[string][]RunSummary, len(state.HistorySummaries)+1)
	for k, v := range state.HistorySummaries {
		histories[k] = v
	}
	histories[key] = summaries

	// Drop currentRunByLoop only when this run was the active one.
	nextCurrent := make(map[string]RunID, len(state.CurrentRunByLoop))
	for k, v := range state.CurrentRunByLoop {
		if k == key && v == run.RunID {
			continue
		}
		nextCurrent[k] = v
	}

	runs := make(map[RunID]RunState, len(state.Runs))
	for k, v := range state.Runs {
		runs[k] = v
	}
	runs[run.RunID] = finalRun

	nextState := EngineState{
		Runs:             runs,
		CurrentRunByLoop: nextCurrent,
		HistorySummaries: histories,
	}

	effects := make([]Effect, 0, len(preceding)+len(cancelEffects)+4)
	effects = append(effects, preceding...)
	effects = append(effects, cancelEffects...)
	effects = append(effects,
		PersistRun{RunState: finalRun},
		PersistLoopState{RunID: run.RunID, LoopState: deriveLoopStateFromRun(finalRun, now)},
		EmitObservation{
			Name: "pipeline.run.terminated",
			Data: map[string]any{
				"runId":        run.RunID,
				"pipelineName": run.PipelineName,
				"reason":       reason,
				"loopState":    finalLoopState,
			},
		},
	)
	if finalRun.BlocksMerge {
		effects = append(effects, EmitObservation{
			Name: "pipeline.run.blocks_merge",
			Data: map[string]any{
				"runId":        run.RunID,
				"pipelineName": run.PipelineName,
				"prUrl":        run.Context.PRURL,
				"headSha":      run.HeadSHA,
			},
		})
	}

	return nextState, effects
}

// runBlocksMerge is the terminal-time merge-blocking decision for a run. Runs
// superseded by a later run (outdated), cancelled by hand, or terminated by a
// config change never block, since they were replaced rather than judged. For
// every other termination, a finally-failed stage whose policy opts into
// blocking blocks merge, and otherwise the exitPredicates.blocksMerge predicate
// (when configured) is evaluated with the same PredicateCtx used for done and
// stalled.
func runBlocksMerge(state EngineState, run RunState, reason RunTerminationReason) bool {
	switch reason {
	case TerminationOutdated, TerminationManualCancel, TerminationConfigChange:
		return false
	}
	for _, stage := range run.PipelineConfigSnapshot.Stages {
		st, ok := run.Stages[stage.Name]
		if !ok || st.Status != StageStatusFailed {
			continue
		}
		if stage.Policy != nil && stage.Policy.BlocksMerge != nil && *stage.Policy.BlocksMerge {
			return true
		}
	}
	exits := run.PipelineConfigSnapshot.ExitPredicates
	if exits == nil || exits.BlocksMerge == nil {
		return false
	}
	ctx := PredicateCtx{
		Run:      &run,
		History:  state.HistorySummaries[LoopKeyFor(run.Context, run.SessionID, run.PipelineName, run.RunID)],
		Findings: run.Findings,
	}
	return Evaluate(*exits.BlocksMerge, ctx)
}

// terminateRun is terminateRunFromState with no preceding effects.
func terminateRun(state EngineState, run RunState, reason RunTerminationReason, now time.Time, finalLoopState LoopStateName) (EngineState, []Effect) {
	return terminateRunFromState(state, run, reason, now, finalLoopState, nil)
}
