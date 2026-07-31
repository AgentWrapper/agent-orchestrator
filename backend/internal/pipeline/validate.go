package pipeline

import (
	"fmt"
	"sort"
	"strings"
)

// Issue is one validation finding, pointing at the offending location in the
// definition document (e.g. "stages[2].needs"). The same shape carries both
// errors and warnings; which one it is depends on where it came back from.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ValidationError collects every Issue found while validating a pipeline
// definition. Validation runs in one pass and reports everything it finds, so
// an author fixes all of it at once instead of fixing-and-reloading one error
// at a time.
type ValidationError struct {
	Issues []Issue
}

// Error joins every issue, one per line, formatted "path: message".
func (e *ValidationError) Error() string {
	var b strings.Builder
	for i, issue := range e.Issues {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(issue.Path)
		b.WriteString(": ")
		b.WriteString(issue.Message)
	}
	return b.String()
}

// Validate applies every edit-time rule from spec section 13 and returns the
// warnings plus, when any rule was broken, a *ValidationError carrying every
// error found.
//
// Warnings are returned alongside errors rather than folded into them: the
// canvas editor renders them differently, and a warned pipeline still saves
// and still runs.
//
// Two things are deliberately not checked here. Unknown credential names
// (spec section 13) need the project's credential store, which arrives with
// the credentials task and widens this seam then. Unknown `workspace:` values
// are left to the JSON schema the editor consumes, because the plan's rule
// list is closed and adding rules here would change what later tasks can
// assume about a validated definition.
func Validate(p *Pipeline) (warnings []Issue, err error) {
	v := &validator{p: p}
	v.run()
	if len(v.errors) > 0 {
		return v.warnings, &ValidationError{Issues: v.errors}
	}
	return v.warnings, nil
}

type validator struct {
	p        *Pipeline
	errors   []Issue
	warnings []Issue
}

func (v *validator) fail(path, format string, args ...any) {
	v.errors = append(v.errors, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
}

func (v *validator) warn(path, format string, args ...any) {
	v.warnings = append(v.warnings, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
}

func (v *validator) run() {
	// Sizing hint only: most definitions are clean, and the common case is a
	// handful of issues on a broken one.
	v.errors = make([]Issue, 0, len(v.p.Stages))
	v.warnings = make([]Issue, 0, 2)

	known := v.checkStages()
	v.checkTriggers()
	v.checkConcurrency()
	v.checkReferences(known)
	v.checkCycles()
	v.checkJoins(known)
	v.checkFailureRouteWarning()
	v.checkSessionWorkspaceWarning()

	if len(v.errors) == 0 {
		v.errors = nil
	}
	if len(v.warnings) == 0 {
		v.warnings = nil
	}
}

// checkStages validates each stage in isolation and returns the set of
// declared stage ids for the reference checks.
func (v *validator) checkStages() map[string]bool {
	if len(v.p.Stages) == 0 {
		v.fail("stages", "pipeline must declare at least one stage")
	}

	known := make(map[string]bool, len(v.p.Stages))
	for i := range v.p.Stages {
		s := &v.p.Stages[i]
		base := fmt.Sprintf("stages[%d]", i)

		if known[s.ID] {
			v.fail(base+".id", "duplicate stage id %q: every stage in a pipeline must have a unique id", s.ID)
		}
		known[s.ID] = true

		switch s.Executor {
		case ExecutorAgent:
			if strings.TrimSpace(s.Agent) == "" {
				v.fail(base+".agent", "agent stage must name an agent")
			}
			if strings.TrimSpace(s.Prompt) == "" {
				v.fail(base+".prompt", "agent stage must declare a prompt")
			}
			if len(s.Credentials) > 0 {
				v.fail(base+".credentials", "credentials are engine-held and injected into command stages only; an agent must never see one")
			}
		case ExecutorCommand:
			if strings.TrimSpace(s.Run) == "" {
				v.fail(base+".run", "command stage must declare a run script")
			}
			if s.Produces != "" {
				v.fail(base+".produces", "produces is an agent-stage contract; a command stage settles on its exit status")
			}
		case "":
			v.fail(base+".executor", "executor is required: %s", quotedExecutorKinds())
		default:
			v.fail(base+".executor", "unknown executor kind %q: %s", s.Executor, quotedExecutorKinds())
		}

		if strings.ContainsAny(s.Produces, `/\`) {
			v.fail(base+".produces", "produces must be a bare filename without a path separator; it resolves under the run's agent-outputs directory")
		}

		if s.Session != nil {
			for j, outcome := range s.Session.KillOn {
				if !outcome.IsKnown() {
					v.fail(fmt.Sprintf("%s.session.kill-on[%d]", base, j), "unknown outcome %q", outcome)
				}
			}
		}
	}
	return known
}

func (v *validator) checkTriggers() {
	for i, e := range v.p.On.PR {
		if !e.IsKnown() {
			v.fail(fmt.Sprintf("on.pr[%d]", i), "unknown pr event %q: %s", e, quotedPREvents())
		}
	}
	for i, e := range v.p.On.Session {
		if !e.IsKnown() {
			v.fail(fmt.Sprintf("on.session[%d]", i), "unknown session event %q: %s", e, quotedSessionEvents())
		}
	}
	// Declaring no events at all is legal: that is a manual-only pipeline.
}

func (v *validator) checkConcurrency() {
	if s := v.p.Concurrency.Scope; s != ConcurrencyScopeUnset && !s.IsKnown() {
		v.fail("concurrency.scope", "unknown concurrency scope %q: %s", s, quotedConcurrencyScopes())
	}
}

// checkReferences rejects every edge naming a stage that does not exist.
func (v *validator) checkReferences(known map[string]bool) {
	for i := range v.p.Stages {
		s := &v.p.Stages[i]
		base := fmt.Sprintf("stages[%d]", i)

		for j, target := range s.OnSuccess {
			if !known[target] {
				v.fail(fmt.Sprintf("%s.on_success[%d]", base, j), "unknown stage id %q", target)
			}
		}
		if s.OnFailure != "" && !known[s.OnFailure] {
			v.fail(base+".on_failure", "unknown stage id %q", s.OnFailure)
		}
		for j, target := range s.Needs {
			if !known[target] {
				v.fail(fmt.Sprintf("%s.needs[%d]", base, j), "unknown stage id %q", target)
			}
		}
	}
	if t := v.p.Defaults.OnFailure; t != "" && !known[t] {
		v.fail("defaults.on_failure", "unknown stage id %q", t)
	}
}

// checkCycles rejects a cycle over the routing graph. The model is a state
// machine, not a DAG: each stage names its successor, so A --fail--> B
// --fail--> A is expressible and is an infinite loop (spec section 9.1).
func (v *validator) checkCycles() {
	cycle := FindFirstCycle(v.p.stageIDs(), v.p.routingEdges())
	if cycle == nil {
		return
	}
	v.fail("stages", "stage graph has a cycle: %s", strings.Join(cycle, " -> "))
}

// checkJoins enforces the needs contract and the inherit-at-a-join rule. Both
// hang off the inbound success edge set; failure edges are never counted
// (spec section 9.2).
func (v *validator) checkJoins(known map[string]bool) {
	inbound := v.p.inboundSuccess()

	for i := range v.p.Stages {
		s := &v.p.Stages[i]
		base := fmt.Sprintf("stages[%d]", i)
		sources := inbound[s.ID]

		if len(sources) > 1 {
			if len(s.Needs) == 0 {
				v.fail(base+".needs", "stage has %d inbound success edges and must declare needs: %s", len(sources), formatIDs(sources))
			}
			if s.Workspace == WorkspaceInherit {
				v.fail(base+".workspace", "workspace: inherit is ambiguous on a stage with %d inbound success edges; name the tree explicitly", len(sources))
			}
		}

		// The equality check runs whenever either side is non-empty; the
		// missing-needs rule above owns the "declared nothing at a join" case.
		if len(s.Needs) == 0 {
			continue
		}
		missing, unexpected := diffIDs(sources, s.Needs)
		// Unknown ids are already reported by checkReferences; do not report
		// them a second time as "unexpected".
		unexpected = filterIDs(unexpected, known)
		if len(missing) > 0 || len(unexpected) > 0 {
			v.fail(base+".needs", "needs does not match the inbound success edges: missing %q, unexpected %q", missing, unexpected)
		}
	}
}

// checkFailureRouteWarning warns when a failure anywhere could end its branch
// in silence. Not an error: a single-stage pipeline does not need a failure
// route (spec section 9.4).
func (v *validator) checkFailureRouteWarning() {
	if v.p.Defaults.OnFailure != "" {
		return
	}
	for i := range v.p.Stages {
		if v.p.Stages[i].OnFailure == "" {
			v.warn("defaults.on_failure",
				"stage %q declares no on_failure and the pipeline declares no defaults.on_failure, so its failure ends the branch silently",
				v.p.Stages[i].ID)
			return
		}
	}
}

// checkSessionWorkspaceWarning warns on the one combination that cannot be
// rejected at edit time, because a pr trigger may or may not have a session
// depending on the PR (spec section 5.3). Plan time turns it into a hard
// failure.
func (v *validator) checkSessionWorkspaceWarning() {
	if len(v.p.On.PR) == 0 {
		return
	}
	for i := range v.p.Stages {
		if v.p.Stages[i].Workspace != WorkspaceSession {
			continue
		}
		v.warn(fmt.Sprintf("stages[%d].workspace", i),
			"workspace: session under a pr trigger fails at plan time when the PR has no local session")
	}
}

// diffIDs compares the actual inbound set against the declared needs and
// returns the ids missing from needs and the ids needs names that are not
// actually inbound. Both results are sorted so the message is stable.
func diffIDs(actual, declared []string) (missing, unexpected []string) {
	actualSet := make(map[string]bool, len(actual))
	for _, id := range actual {
		actualSet[id] = true
	}
	declaredSet := make(map[string]bool, len(declared))
	for _, id := range declared {
		declaredSet[id] = true
	}

	missing = make([]string, 0, len(actual))
	for _, id := range actual {
		if !declaredSet[id] {
			missing = append(missing, id)
		}
	}
	unexpected = make([]string, 0, len(declared))
	for _, id := range declared {
		if !actualSet[id] {
			unexpected = append(unexpected, id)
		}
	}
	sort.Strings(missing)
	sort.Strings(unexpected)
	return missing, unexpected
}

// filterIDs keeps only the ids present in keep.
func filterIDs(ids []string, keep map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if keep[id] {
			out = append(out, id)
		}
	}
	return out
}

func formatIDs(ids []string) string {
	sorted := make([]string, len(ids))
	copy(sorted, ids)
	sort.Strings(sorted)
	return fmt.Sprintf("%q", sorted)
}

func quotedExecutorKinds() string {
	out := make([]string, 0, len(AllExecutorKinds))
	for _, k := range AllExecutorKinds {
		out = append(out, string(k))
	}
	return "must be one of " + fmt.Sprintf("%q", out)
}

func quotedPREvents() string {
	out := make([]string, 0, len(AllPREvents))
	for _, e := range AllPREvents {
		out = append(out, string(e))
	}
	return "must be one of " + fmt.Sprintf("%q", out)
}

func quotedSessionEvents() string {
	out := make([]string, 0, len(AllSessionEvents))
	for _, e := range AllSessionEvents {
		out = append(out, string(e))
	}
	return "must be one of " + fmt.Sprintf("%q", out)
}

func quotedConcurrencyScopes() string {
	out := make([]string, 0, len(AllConcurrencyScopes))
	for _, s := range AllConcurrencyScopes {
		out = append(out, string(s))
	}
	return "must be one of " + fmt.Sprintf("%q", out)
}
