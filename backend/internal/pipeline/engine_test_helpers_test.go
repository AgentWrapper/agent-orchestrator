package pipeline

import (
	"testing"
	"time"
)

// Shared constructors for the reducer / scheduler / evaluator tests.

func intPtr(i int) *int { return &i }

func int64Ptr(i int64) *int64 { return &i }

// wedgeStage returns a copy of state with runID's stage marked running with a
// StartedAt and Deadline both set to at, so a Tick at any later Now expires it.
// Test-only shortcut for building "stuck inflight stage" states.
func wedgeStage(state EngineState, runID RunID, stageName string, at time.Time) EngineState {
	run := state.Runs[runID]
	s := run.Stages[stageName]
	s.Status = StageStatusRunning
	s.StartedAt = &at
	s.Deadline = &at
	return replaceRun(state, patchRun(run, map[string]StageState{stageName: s}, at))
}

// testNow is a fixed clock; the reducer is pure so any stable value works.
var testNow = time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)

// stageDef builds a Stage with the given name and dependsOn edges.
func stageDef(name string, dependsOn ...string) Stage {
	return Stage{Name: name, DependsOn: dependsOn}
}

// withRoutes returns a copy of s with a routes.when predicate attached.
func withRoutes(s Stage, when Predicate) Stage {
	s.Routes = &StageRoutes{When: when}
	return s
}

// pipelineOf builds a Pipeline from stages with an optional concurrency cap.
func pipelineOf(name string, maxConcurrent int, stages ...Stage) Pipeline {
	p := Pipeline{ID: "pl-1", Name: name, Stages: stages}
	if maxConcurrent > 0 {
		p.MaxConcurrentStages = intPtr(maxConcurrent)
	}
	return p
}

// stageRunIDsFor allocates one StageRunID per stage, mirroring the driver.
func stageRunIDsFor(p Pipeline) map[string]StageRunID {
	out := make(map[string]StageRunID, len(p.Stages))
	for _, s := range p.Stages {
		out[s.Name] = StageRunID("sr-" + s.Name)
	}
	return out
}

// runState builds a RunState with the given stage statuses (keyed by name).
// Every stage gets a stable stageRunId and attempt 1 unless overridden later.
func runState(runID RunID, p Pipeline, statuses map[string]StageStatus) RunState {
	stages := make(map[string]StageState, len(p.Stages))
	for _, s := range p.Stages {
		st := StageState{StageRunID: StageRunID("sr-" + s.Name), Status: StageStatusPending, Attempt: 1}
		if status, ok := statuses[s.Name]; ok {
			st.Status = status
		}
		stages[s.Name] = st
	}
	return RunState{
		RunID:                  runID,
		PipelineID:             p.ID,
		PipelineName:           p.Name,
		SessionID:              "sess-1",
		PipelineConfigSnapshot: p,
		HeadSHA:                "sha-1",
		LoopState:              LoopRunning,
		LoopRounds:             1,
		Stages:                 stages,
		CreatedAt:              testNow,
		UpdatedAt:              testNow,
	}
}

// engineWith puts a single run into an otherwise-empty engine state, marking it
// active for its loop key.
func engineWith(run RunState) EngineState {
	st := EmptyEngineState()
	st.Runs[run.RunID] = run
	st.CurrentRunByLoop[LoopKey(run.SessionID, run.PipelineName)] = run.RunID
	return st
}

// effectsByType groups effects by their EffectType for assertion convenience.
func effectsByType(effects []Effect) map[EffectType][]Effect {
	out := map[EffectType][]Effect{}
	for _, e := range effects {
		out[e.Type()] = append(out[e.Type()], e)
	}
	return out
}

// startedStageNames returns the stage names of every START_STAGE effect, in
// emission order.
func startedStageNames(effects []Effect) []string {
	var out []string
	for _, e := range effects {
		if s, ok := e.(StartStage); ok {
			out = append(out, s.Stage.Name)
		}
	}
	return out
}

// requireEffect fails the test unless exactly one effect of the given type is
// present, returning it.
func requireOneEffect[T Effect](t *testing.T, effects []Effect) T {
	t.Helper()
	var found T
	count := 0
	for _, e := range effects {
		if v, ok := e.(T); ok {
			found = v
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one %T effect, got %d", found, count)
	}
	return found
}
