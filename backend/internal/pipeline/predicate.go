package pipeline

import "fmt"

// PredicateKind names a leaf or composite form in the typed predicate DSL.
//
// This is a deliberately narrower set than the old TypeScript DSL: it drops
// "v0_default" (the legacy hardcoded-rule escape hatch) and the legacy
// allSucceeded/anySucceeded/anyFailed shapes (both superseded by the typed
// forms), and drops the pipeline-v3 workstream predicates
// (all_workstream_workers_in_state, all_workstream_workers_match,
// workstream_member_count), which are phase 2.
type PredicateKind string

// Known predicate kinds.
const (
	PredicateAllPass             PredicateKind = "all_pass"
	PredicateAnyPass             PredicateKind = "any_pass"
	PredicateMajorityPass        PredicateKind = "majority_pass"
	PredicateNoOpenFindings      PredicateKind = "no_open_findings"
	PredicateFindingCountBelow   PredicateKind = "finding_count_below"
	PredicateLoopRoundsAtLeast   PredicateKind = "loop_rounds_at_least"
	PredicateStageRetriedAtLeast PredicateKind = "stage_retried_at_least"
	PredicateStageVerdict        PredicateKind = "stage_verdict"
	PredicateAnd                 PredicateKind = "and"
	PredicateOr                  PredicateKind = "or"
	PredicateNot                 PredicateKind = "not"
)

// AllPredicateKinds lists every known predicate kind.
var AllPredicateKinds = []PredicateKind{
	PredicateAllPass, PredicateAnyPass, PredicateMajorityPass,
	PredicateNoOpenFindings, PredicateFindingCountBelow, PredicateLoopRoundsAtLeast,
	PredicateStageRetriedAtLeast, PredicateStageVerdict,
	PredicateAnd, PredicateOr, PredicateNot,
}

// IsKnown reports whether k is a known predicate kind.
func (k PredicateKind) IsKnown() bool {
	for _, known := range AllPredicateKinds {
		if k == known {
			return true
		}
	}
	return false
}

// Predicate is a single tagged struct covering every kind in the typed
// predicate DSL, since it is parsed straight out of YAML/JSON as a recursive
// union. Only the fields relevant to Kind are meaningful; Validate rejects
// fields set on the wrong kind.
type Predicate struct {
	Kind PredicateKind `json:"kind" yaml:"kind"`

	// Stages: all_pass, any_pass, majority_pass.
	Stages []string `json:"stages,omitempty" yaml:"stages,omitempty"`
	// Stage: no_open_findings (optional), finding_count_below (optional),
	// stage_retried_at_least (required), stage_verdict (required).
	Stage string `json:"stage,omitempty" yaml:"stage,omitempty"`
	// Severity: finding_count_below (optional).
	Severity Severity `json:"severity,omitempty" yaml:"severity,omitempty"`
	// Max: finding_count_below (required).
	Max *int `json:"max,omitempty" yaml:"max,omitempty"`
	// N: loop_rounds_at_least (required), stage_retried_at_least (required).
	N *int `json:"n,omitempty" yaml:"n,omitempty"`
	// Verdict: stage_verdict (required).
	Verdict Verdict `json:"verdict,omitempty" yaml:"verdict,omitempty"`
	// Predicates: and, or (required, length >= 1).
	Predicates []Predicate `json:"predicates,omitempty" yaml:"predicates,omitempty"`
	// Predicate: not (required).
	Predicate *Predicate `json:"predicate,omitempty" yaml:"predicate,omitempty"`
}

// predicateFieldRules returns which of the union fields are allowed at all
// for kind, and which of those are required, keyed by the JSON field name.
// The second return value is false for an unknown kind.
func predicateFieldRules(kind PredicateKind) (allowed, required map[string]bool, ok bool) {
	switch kind {
	case PredicateAllPass, PredicateAnyPass, PredicateMajorityPass:
		return map[string]bool{"stages": true}, map[string]bool{"stages": true}, true
	case PredicateNoOpenFindings:
		return map[string]bool{"stage": true}, nil, true
	case PredicateFindingCountBelow:
		return map[string]bool{"max": true, "stage": true, "severity": true},
			map[string]bool{"max": true}, true
	case PredicateLoopRoundsAtLeast:
		return map[string]bool{"n": true}, map[string]bool{"n": true}, true
	case PredicateStageRetriedAtLeast:
		return map[string]bool{"stage": true, "n": true},
			map[string]bool{"stage": true, "n": true}, true
	case PredicateStageVerdict:
		return map[string]bool{"stage": true, "verdict": true},
			map[string]bool{"stage": true, "verdict": true}, true
	case PredicateAnd, PredicateOr:
		return map[string]bool{"predicates": true}, map[string]bool{"predicates": true}, true
	case PredicateNot:
		return map[string]bool{"predicate": true}, map[string]bool{"predicate": true}, true
	default:
		return nil, nil, false
	}
}

// predicateFieldNames is the fixed order union fields are reported in, so
// cross-kind rejection issues come out deterministically.
var predicateFieldNames = []string{
	"stages", "stage", "severity", "max", "n", "verdict", "predicates", "predicate",
}

// presentFields reports which union fields carry a non-zero value on p.
func (p *Predicate) presentFields() map[string]bool {
	return map[string]bool{
		"stages":     len(p.Stages) > 0,
		"stage":      p.Stage != "",
		"severity":   p.Severity != "",
		"max":        p.Max != nil,
		"n":          p.N != nil,
		"verdict":    p.Verdict != "",
		"predicates": len(p.Predicates) > 0,
		"predicate":  p.Predicate != nil,
	}
}

// childPath appends name to base with a "." separator, omitting the
// separator when base is empty (top of the document).
func childPath(base, name string) string {
	if base == "" {
		return name
	}
	return base + "." + name
}

// Validate recursively validates p, hand-written equivalent of the old
// Zod z.lazy recursive schema. path is the location of p within its
// containing document (e.g. "routes.when" or "exitPredicates.done"); nested
// issues get index/field suffixes appended (e.g. "routes.when.predicates[1].predicate").
//
// Per kind, this checks required fields are present and valid, and rejects
// fields that belong to another kind. An unknown kind is a single issue.
func (p *Predicate) Validate(path string) []Issue {
	var issues []Issue
	addf := func(format string, args ...any) {
		issues = append(issues, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}

	allowed, _, ok := predicateFieldRules(p.Kind)
	if !ok {
		addf("unknown predicate kind %q", p.Kind)
		return issues
	}

	present := p.presentFields()
	for _, name := range predicateFieldNames {
		if present[name] && !allowed[name] {
			addf("field %q is not valid for predicate kind %q", name, p.Kind)
		}
	}

	switch p.Kind {
	case PredicateAllPass, PredicateAnyPass, PredicateMajorityPass:
		if len(p.Stages) == 0 {
			addf("%q requires at least one stage", p.Kind)
		}
		for i, s := range p.Stages {
			if s == "" {
				issues = append(issues, Issue{
					Path:    childPath(path, fmt.Sprintf("stages[%d]", i)),
					Message: "stage name must not be empty",
				})
			}
		}
	case PredicateNoOpenFindings:
		// Stage is optional; nothing further to check.
	case PredicateFindingCountBelow:
		if p.Max == nil {
			addf("finding_count_below requires max")
		} else if *p.Max < 0 {
			addf("finding_count_below max must be >= 0")
		}
		if p.Severity != "" && !p.Severity.IsKnown() {
			addf("unknown severity %q", p.Severity)
		}
	case PredicateLoopRoundsAtLeast:
		if p.N == nil {
			addf("loop_rounds_at_least requires n")
		} else if *p.N < 1 {
			addf("loop_rounds_at_least n must be >= 1")
		}
	case PredicateStageRetriedAtLeast:
		if p.Stage == "" {
			addf("stage_retried_at_least requires stage")
		}
		if p.N == nil {
			addf("stage_retried_at_least requires n")
		} else if *p.N < 1 {
			addf("stage_retried_at_least n must be >= 1")
		}
	case PredicateStageVerdict:
		if p.Stage == "" {
			addf("stage_verdict requires stage")
		}
		if p.Verdict == "" {
			addf("stage_verdict requires verdict")
		} else if !p.Verdict.IsKnown() {
			addf("unknown verdict %q", p.Verdict)
		}
	case PredicateAnd, PredicateOr:
		if len(p.Predicates) == 0 {
			addf("%q requires at least one predicate", p.Kind)
		}
		for i := range p.Predicates {
			issues = append(issues, p.Predicates[i].Validate(childPath(path, fmt.Sprintf("predicates[%d]", i)))...)
		}
	case PredicateNot:
		if p.Predicate == nil {
			addf("not requires predicate")
		} else {
			issues = append(issues, p.Predicate.Validate(childPath(path, "predicate"))...)
		}
	}

	return issues
}

// ReferencedStages returns the deduped list of stage names p references,
// collected across the whole predicate tree (and/or/not recurse). Order is
// first-seen (depth-first, left to right), matching the old TypeScript
// predicateReferencedStages, which built the same set via insertion order.
func (p *Predicate) ReferencedStages() []string {
	seen := map[string]bool{}
	var out []string
	add := func(stage string) {
		if stage == "" || seen[stage] {
			return
		}
		seen[stage] = true
		out = append(out, stage)
	}
	var visit func(pr *Predicate)
	visit = func(pr *Predicate) {
		if pr == nil {
			return
		}
		switch pr.Kind {
		case PredicateAllPass, PredicateAnyPass, PredicateMajorityPass:
			for _, s := range pr.Stages {
				add(s)
			}
		case PredicateStageVerdict, PredicateStageRetriedAtLeast:
			add(pr.Stage)
		case PredicateNoOpenFindings, PredicateFindingCountBelow:
			if pr.Stage != "" {
				add(pr.Stage)
			}
		case PredicateAnd, PredicateOr:
			for i := range pr.Predicates {
				visit(&pr.Predicates[i])
			}
		case PredicateNot:
			visit(pr.Predicate)
		}
	}
	visit(p)
	return out
}
