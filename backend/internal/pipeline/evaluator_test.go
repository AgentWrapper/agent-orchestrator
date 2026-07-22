package pipeline

import "testing"

// stagesWith builds a bare run whose stages carry the given statuses (and
// optional verdicts/attempts), for evaluator table tests.
func evalRun(stages map[string]StageState, loopRounds int) *RunState {
	return &RunState{Stages: stages, LoopRounds: loopRounds}
}

func openFinding(stage string, sev Severity) Artifact {
	return Artifact{
		ArtifactInput: ArtifactInput{Kind: ArtifactKindFinding, Severity: sev},
		StageName:     stage,
		Status:        ArtifactStatusOpen,
	}
}

func TestEvaluate(t *testing.T) {
	succeeded := StageState{Status: StageStatusSucceeded}
	failed := StageState{Status: StageStatusFailed}
	running := StageState{Status: StageStatusRunning}

	tests := []struct {
		name string
		p    Predicate
		ctx  PredicateCtx
		want bool
	}{
		{
			name: "all_pass true when every stage succeeded",
			p:    Predicate{Kind: PredicateAllPass, Stages: []string{"a", "b"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded, "b": succeeded}, 1)},
			want: true,
		},
		{
			name: "all_pass false when one failed",
			p:    Predicate{Kind: PredicateAllPass, Stages: []string{"a", "b"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded, "b": failed}, 1)},
			want: false,
		},
		{
			name: "all_pass false on missing stage (never green-light on missing data)",
			p:    Predicate{Kind: PredicateAllPass, Stages: []string{"a", "ghost"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded}, 1)},
			want: false,
		},
		{
			name: "any_pass true when one succeeded",
			p:    Predicate{Kind: PredicateAnyPass, Stages: []string{"a", "b"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": failed, "b": succeeded}, 1)},
			want: true,
		},
		{
			name: "any_pass false when none succeeded",
			p:    Predicate{Kind: PredicateAnyPass, Stages: []string{"a", "b"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": failed, "b": running}, 1)},
			want: false,
		},
		{
			name: "majority_pass true (2 of 3)",
			p:    Predicate{Kind: PredicateMajorityPass, Stages: []string{"a", "b", "c"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded, "b": succeeded, "c": failed}, 1)},
			want: true,
		},
		{
			name: "majority_pass false on exact tie (1 of 2)",
			p:    Predicate{Kind: PredicateMajorityPass, Stages: []string{"a", "b"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded, "b": failed}, 1)},
			want: false,
		},
		{
			name: "majority_pass false on empty stage list",
			p:    Predicate{Kind: PredicateMajorityPass, Stages: []string{}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{}, 1)},
			want: false,
		},
		{
			name: "no_open_findings true with no findings",
			p:    Predicate{Kind: PredicateNoOpenFindings},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{}, 1)},
			want: true,
		},
		{
			name: "no_open_findings false when an open finding exists",
			p:    Predicate{Kind: PredicateNoOpenFindings},
			ctx: PredicateCtx{
				Run:      evalRun(map[string]StageState{}, 1),
				Findings: []Artifact{openFinding("a", SeverityError)},
			},
			want: false,
		},
		{
			name: "no_open_findings scoped to a stage ignores other stages",
			p:    Predicate{Kind: PredicateNoOpenFindings, Stage: "a"},
			ctx: PredicateCtx{
				Run:      evalRun(map[string]StageState{}, 1),
				Findings: []Artifact{openFinding("b", SeverityError)},
			},
			want: true,
		},
		{
			name: "no_open_findings ignores dismissed findings",
			p:    Predicate{Kind: PredicateNoOpenFindings},
			ctx: PredicateCtx{
				Run: evalRun(map[string]StageState{}, 1),
				Findings: []Artifact{{
					ArtifactInput: ArtifactInput{Kind: ArtifactKindFinding},
					StageName:     "a", Status: ArtifactStatusDismissed,
				}},
			},
			want: true,
		},
		{
			name: "finding_count_below true when count under max",
			p:    Predicate{Kind: PredicateFindingCountBelow, Max: intPtr(2)},
			ctx: PredicateCtx{
				Run:      evalRun(map[string]StageState{}, 1),
				Findings: []Artifact{openFinding("a", SeverityError)},
			},
			want: true,
		},
		{
			name: "finding_count_below false when count equals max",
			p:    Predicate{Kind: PredicateFindingCountBelow, Max: intPtr(1)},
			ctx: PredicateCtx{
				Run:      evalRun(map[string]StageState{}, 1),
				Findings: []Artifact{openFinding("a", SeverityError)},
			},
			want: false,
		},
		{
			name: "finding_count_below filters by severity",
			p:    Predicate{Kind: PredicateFindingCountBelow, Max: intPtr(1), Severity: SeverityError},
			ctx: PredicateCtx{
				Run:      evalRun(map[string]StageState{}, 1),
				Findings: []Artifact{openFinding("a", SeverityWarning), openFinding("a", SeverityWarning)},
			},
			want: true, // zero errors < 1 even though two warnings exist
		},
		{
			name: "loop_rounds_at_least true",
			p:    Predicate{Kind: PredicateLoopRoundsAtLeast, N: intPtr(3)},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{}, 3)},
			want: true,
		},
		{
			name: "loop_rounds_at_least false",
			p:    Predicate{Kind: PredicateLoopRoundsAtLeast, N: intPtr(3)},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{}, 2)},
			want: false,
		},
		{
			name: "stage_retried_at_least true",
			p:    Predicate{Kind: PredicateStageRetriedAtLeast, Stage: "a", N: intPtr(2)},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": {Status: StageStatusFailed, Attempt: 2}}, 1)},
			want: true,
		},
		{
			name: "stage_retried_at_least false on missing stage",
			p:    Predicate{Kind: PredicateStageRetriedAtLeast, Stage: "ghost", N: intPtr(1)},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{}, 1)},
			want: false,
		},
		{
			name: "stage_verdict maps succeeded to pass",
			p:    Predicate{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictPass},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded}, 1)},
			want: true,
		},
		{
			name: "stage_verdict maps failed to fail",
			p:    Predicate{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictFail},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": failed}, 1)},
			want: true,
		},
		{
			name: "stage_verdict explicit verdict wins over status mapping",
			p:    Predicate{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictNeutral},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": {Status: StageStatusSucceeded, Verdict: VerdictNeutral}}, 1)},
			want: true,
		},
		{
			name: "stage_verdict running maps to neutral",
			p:    Predicate{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictNeutral},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": running}, 1)},
			want: true,
		},
		{
			name: "and true when both branches true",
			p: Predicate{Kind: PredicateAnd, Predicates: []Predicate{
				{Kind: PredicateAllPass, Stages: []string{"a"}},
				{Kind: PredicateLoopRoundsAtLeast, N: intPtr(1)},
			}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded}, 1)},
			want: true,
		},
		{
			name: "and false when one branch false",
			p: Predicate{Kind: PredicateAnd, Predicates: []Predicate{
				{Kind: PredicateAllPass, Stages: []string{"a"}},
				{Kind: PredicateAllPass, Stages: []string{"b"}},
			}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded, "b": failed}, 1)},
			want: false,
		},
		{
			name: "or true when one branch true",
			p: Predicate{Kind: PredicateOr, Predicates: []Predicate{
				{Kind: PredicateAllPass, Stages: []string{"a"}},
				{Kind: PredicateAllPass, Stages: []string{"b"}},
			}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": failed, "b": succeeded}, 1)},
			want: true,
		},
		{
			name: "not flips a false leaf to true (unknown stage)",
			p:    Predicate{Kind: PredicateNot, Predicate: &Predicate{Kind: PredicateAllPass, Stages: []string{"ghost"}}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{}, 1)},
			want: true,
		},
		{
			name: "nested composite: (a AND (NOT b_pass)) OR loop>=5",
			p: Predicate{Kind: PredicateOr, Predicates: []Predicate{
				{Kind: PredicateAnd, Predicates: []Predicate{
					{Kind: PredicateAllPass, Stages: []string{"a"}},
					{Kind: PredicateNot, Predicate: &Predicate{Kind: PredicateAllPass, Stages: []string{"b"}}},
				}},
				{Kind: PredicateLoopRoundsAtLeast, N: intPtr(5)},
			}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded, "b": failed}, 1)},
			want: true,
		},
		{
			name: "routes-time context with empty history still evaluates leaves",
			p:    Predicate{Kind: PredicateAnyPass, Stages: []string{"a"}},
			ctx:  PredicateCtx{Run: evalRun(map[string]StageState{"a": succeeded}, 1), History: nil},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Evaluate(tt.p, tt.ctx); got != tt.want {
				t.Fatalf("Evaluate() = %v, want %v", got, tt.want)
			}
		})
	}
}
