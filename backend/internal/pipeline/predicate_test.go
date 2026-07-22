package pipeline

import (
	"strings"
	"testing"
)

func intp(n int) *int { return &n }

func TestPredicateValidate_Valid(t *testing.T) {
	cases := map[string]Predicate{
		"all_pass":                      {Kind: PredicateAllPass, Stages: []string{"a", "b"}},
		"any_pass":                      {Kind: PredicateAnyPass, Stages: []string{"a"}},
		"majority_pass":                 {Kind: PredicateMajorityPass, Stages: []string{"a", "b", "c"}},
		"no_open_findings (bare)":       {Kind: PredicateNoOpenFindings},
		"no_open_findings (with stage)": {Kind: PredicateNoOpenFindings, Stage: "a"},
		"finding_count_below (bare)":    {Kind: PredicateFindingCountBelow, Max: intp(0)},
		"finding_count_below (full)": {
			Kind: PredicateFindingCountBelow, Max: intp(3), Stage: "a", Severity: SeverityWarning,
		},
		"loop_rounds_at_least":   {Kind: PredicateLoopRoundsAtLeast, N: intp(1)},
		"stage_retried_at_least": {Kind: PredicateStageRetriedAtLeast, Stage: "a", N: intp(2)},
		"stage_verdict":          {Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictPass},
		"and": {
			Kind: PredicateAnd,
			Predicates: []Predicate{
				{Kind: PredicateAllPass, Stages: []string{"a"}},
				{Kind: PredicateStageVerdict, Stage: "b", Verdict: VerdictFail},
			},
		},
		"or": {
			Kind: PredicateOr,
			Predicates: []Predicate{
				{Kind: PredicateNoOpenFindings},
				{Kind: PredicateLoopRoundsAtLeast, N: intp(2)},
			},
		},
		"not": {
			Kind:      PredicateNot,
			Predicate: &Predicate{Kind: PredicateAllPass, Stages: []string{"a"}},
		},
		"deeply nested composite": {
			Kind: PredicateAnd,
			Predicates: []Predicate{
				{
					Kind: PredicateOr,
					Predicates: []Predicate{
						{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictPass},
						{
							Kind:      PredicateNot,
							Predicate: &Predicate{Kind: PredicateNoOpenFindings, Stage: "b"},
						},
					},
				},
				{Kind: PredicateLoopRoundsAtLeast, N: intp(3)},
			},
		},
	}

	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			p := p
			if issues := p.Validate(""); len(issues) != 0 {
				t.Fatalf("expected no issues, got %+v", issues)
			}
		})
	}
}

func TestPredicateValidate_Invalid(t *testing.T) {
	cases := []struct {
		name        string
		predicate   Predicate
		wantPathSub string
		wantMsgSub  string
	}{
		{
			name:        "unknown kind",
			predicate:   Predicate{Kind: "bogus"},
			wantPathSub: "",
			wantMsgSub:  "unknown predicate kind",
		},
		{
			name:       "empty stages on all_pass",
			predicate:  Predicate{Kind: PredicateAllPass, Stages: []string{}},
			wantMsgSub: "requires at least one stage",
		},
		{
			name:        "empty string stage entry",
			predicate:   Predicate{Kind: PredicateAnyPass, Stages: []string{"a", ""}},
			wantPathSub: "stages[1]",
			wantMsgSub:  "must not be empty",
		},
		{
			name:       "missing max",
			predicate:  Predicate{Kind: PredicateFindingCountBelow},
			wantMsgSub: "requires max",
		},
		{
			name:       "negative max",
			predicate:  Predicate{Kind: PredicateFindingCountBelow, Max: intp(-1)},
			wantMsgSub: "must be >= 0",
		},
		{
			name:       "n=0 on loop_rounds_at_least",
			predicate:  Predicate{Kind: PredicateLoopRoundsAtLeast, N: intp(0)},
			wantMsgSub: "must be >= 1",
		},
		{
			name:       "missing verdict",
			predicate:  Predicate{Kind: PredicateStageVerdict, Stage: "a"},
			wantMsgSub: "requires verdict",
		},
		{
			name:       "empty predicates on and",
			predicate:  Predicate{Kind: PredicateAnd},
			wantMsgSub: "requires at least one predicate",
		},
		{
			name:       "empty predicates on or",
			predicate:  Predicate{Kind: PredicateOr, Predicates: []Predicate{}},
			wantMsgSub: "requires at least one predicate",
		},
		{
			name:       "missing predicate on not",
			predicate:  Predicate{Kind: PredicateNot},
			wantMsgSub: "requires predicate",
		},
		{
			name:       "cross-kind field set (all_pass with n)",
			predicate:  Predicate{Kind: PredicateAllPass, Stages: []string{"a"}, N: intp(1)},
			wantMsgSub: `not valid for predicate kind "all_pass"`,
		},
		{
			name: "nested composite with invalid leaf",
			predicate: Predicate{
				Kind: PredicateOr,
				Predicates: []Predicate{
					{Kind: PredicateNoOpenFindings},
					{
						Kind:      PredicateNot,
						Predicate: &Predicate{Kind: PredicateLoopRoundsAtLeast}, // missing n
					},
				},
			},
			wantPathSub: "predicates[1].predicate",
			wantMsgSub:  "requires n",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issues := tc.predicate.Validate("")
			if len(issues) == 0 {
				t.Fatalf("expected issues, got none")
			}
			var found bool
			for _, issue := range issues {
				if strings.Contains(issue.Message, tc.wantMsgSub) &&
					(tc.wantPathSub == "" || strings.Contains(issue.Path, tc.wantPathSub)) {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("no issue matched path substring %q / message substring %q; got %+v",
					tc.wantPathSub, tc.wantMsgSub, issues)
			}
		})
	}
}

func TestPredicateReferencedStages(t *testing.T) {
	cases := []struct {
		name      string
		predicate Predicate
		want      []string
	}{
		{
			name:      "all_pass collects stages",
			predicate: Predicate{Kind: PredicateAllPass, Stages: []string{"a", "b"}},
			want:      []string{"a", "b"},
		},
		{
			name:      "stage_verdict collects stage",
			predicate: Predicate{Kind: PredicateStageVerdict, Stage: "a", Verdict: VerdictPass},
			want:      []string{"a"},
		},
		{
			name:      "stage_retried_at_least collects stage",
			predicate: Predicate{Kind: PredicateStageRetriedAtLeast, Stage: "a", N: intp(1)},
			want:      []string{"a"},
		},
		{
			name:      "no_open_findings includes optional stage when set",
			predicate: Predicate{Kind: PredicateNoOpenFindings, Stage: "a"},
			want:      []string{"a"},
		},
		{
			name:      "no_open_findings omits stage when unset",
			predicate: Predicate{Kind: PredicateNoOpenFindings},
			want:      nil,
		},
		{
			name:      "finding_count_below includes optional stage when set",
			predicate: Predicate{Kind: PredicateFindingCountBelow, Max: intp(1), Stage: "b"},
			want:      []string{"b"},
		},
		{
			name: "nested and/or/not dedups across the tree, first-seen order",
			predicate: Predicate{
				Kind: PredicateAnd,
				Predicates: []Predicate{
					{Kind: PredicateAllPass, Stages: []string{"a", "b"}},
					{
						Kind: PredicateOr,
						Predicates: []Predicate{
							{Kind: PredicateStageVerdict, Stage: "b", Verdict: VerdictFail},
							{
								Kind:      PredicateNot,
								Predicate: &Predicate{Kind: PredicateStageRetriedAtLeast, Stage: "c", N: intp(1)},
							},
						},
					},
					{Kind: PredicateAllPass, Stages: []string{"a"}},
				},
			},
			want: []string{"a", "b", "c"},
		},
		{
			name:      "loop_rounds_at_least references nothing",
			predicate: Predicate{Kind: PredicateLoopRoundsAtLeast, N: intp(1)},
			want:      nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.predicate.ReferencedStages()
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}
