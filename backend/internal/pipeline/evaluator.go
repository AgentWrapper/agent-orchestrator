package pipeline

// Pure predicate evaluator for the typed Predicate DSL.
//
// Used by:
//   - the DAG scheduler (scheduler.go) to decide whether a stage's
//     routes.when predicate is satisfied and the stage should run vs skip, and
//   - the reducer (reducer.go) to decide the run's exit state (done / stalled)
//     when pipeline.exitPredicates is configured.
//
// Purity: no I/O, no clock reads, no package-level state. Every input is in
// PredicateCtx. Stages referenced by name are looked up in ctx.Run.Stages;
// unknown names degrade to false for positive checks (we never green-light on
// missing data), but not() flips that to true. Config validation catches
// dangling stage names at load time so the runtime never sees them.
//
// Ported from the old TypeScript predicate-evaluator.ts, minus the dropped
// v0_default kind, the legacy allSucceeded/anySucceeded/anyFailed
// normalization, and the deferred workstream predicates.

// Evaluate reports whether p is satisfied against ctx.
func Evaluate(p Predicate, ctx PredicateCtx) bool {
	switch p.Kind {
	case PredicateAllPass:
		for _, name := range p.Stages {
			if !isSucceeded(ctx.stage(name)) {
				return false
			}
		}
		return true
	case PredicateAnyPass:
		for _, name := range p.Stages {
			if isSucceeded(ctx.stage(name)) {
				return true
			}
		}
		return false
	case PredicateMajorityPass:
		if len(p.Stages) == 0 {
			return false
		}
		passed := 0
		for _, name := range p.Stages {
			if isSucceeded(ctx.stage(name)) {
				passed++
			}
		}
		return passed*2 > len(p.Stages)
	case PredicateNoOpenFindings:
		return countOpenFindings(ctx.Findings, p.Stage, "") == 0
	case PredicateFindingCountBelow:
		if p.Max == nil {
			// Guarded by config validation; treat a missing bound as
			// unsatisfiable rather than panicking.
			return false
		}
		return countOpenFindings(ctx.Findings, p.Stage, p.Severity) < *p.Max
	case PredicateLoopRoundsAtLeast:
		if p.N == nil || ctx.Run == nil {
			return false
		}
		return ctx.Run.LoopRounds >= *p.N
	case PredicateStageRetriedAtLeast:
		if p.N == nil {
			return false
		}
		stage := ctx.stage(p.Stage)
		if stage == nil {
			return false
		}
		return stage.Attempt >= *p.N
	case PredicateStageVerdict:
		stage := ctx.stage(p.Stage)
		if stage == nil {
			return false
		}
		return effectiveVerdict(*stage) == p.Verdict
	case PredicateAnd:
		for i := range p.Predicates {
			if !Evaluate(p.Predicates[i], ctx) {
				return false
			}
		}
		return true
	case PredicateOr:
		for i := range p.Predicates {
			if Evaluate(p.Predicates[i], ctx) {
				return true
			}
		}
		return false
	case PredicateNot:
		if p.Predicate == nil {
			return false
		}
		return !Evaluate(*p.Predicate, ctx)
	default:
		// Unknown kind: config validation rejects these before runtime, and we
		// never green-light on data we don't understand.
		return false
	}
}

// stage looks up a stage's runtime state by name, returning nil when the run
// or the stage is absent.
func (ctx PredicateCtx) stage(name string) *StageState {
	if ctx.Run == nil {
		return nil
	}
	s, ok := ctx.Run.Stages[name]
	if !ok {
		return nil
	}
	return &s
}

func isSucceeded(s *StageState) bool {
	return s != nil && s.Status == StageStatusSucceeded
}

// effectiveVerdict maps a stage's lifecycle status onto a Verdict so
// stage_verdict queries work even for stages that carry no explicit verdict:
// an explicit verdict always wins; succeeded => pass; failed => fail;
// everything else (pending/running/skipped/outdated) => neutral.
func effectiveVerdict(s StageState) Verdict {
	if s.Verdict != "" {
		return s.Verdict
	}
	switch s.Status {
	case StageStatusSucceeded:
		return VerdictPass
	case StageStatusFailed:
		return VerdictFail
	default:
		return VerdictNeutral
	}
}

// countOpenFindings counts open finding artifacts, optionally filtered by
// stage name and severity (empty filters match any).
func countOpenFindings(findings []Artifact, stageName string, severity Severity) int {
	count := 0
	for i := range findings {
		a := &findings[i]
		if a.Kind != ArtifactKindFinding {
			continue
		}
		if a.Status != ArtifactStatusOpen {
			continue
		}
		if stageName != "" && a.StageName != stageName {
			continue
		}
		if severity != "" && a.Severity != severity {
			continue
		}
		count++
	}
	return count
}
