package pipeline

import (
	"bytes"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// Issue is one validation failure, pointing at the offending location in the
// definition document (e.g. "stages[2].dependsOn").
type Issue struct {
	Path    string
	Message string
}

// ValidationError collects every Issue found while validating a pipeline
// definition. The old Zod schema's superRefine surfaced a single
// consolidated failure across every rule violated; ValidationError preserves
// that so a config author sees every problem in one pass instead of
// fixing-and-reloading one error at a time.
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

// ParseDefinition decodes a single-document YAML pipeline definition
// (v1 config format: one pipeline per document, authored in an editor and
// stored in SQLite, unlike the old map-of-pipelines agent-orchestrator.yaml
// file format), validates it, and returns the normalized *Pipeline.
//
// ID is never part of the YAML document; it is assigned by the store when
// the definition is saved (a later task). Name is required (there is no map
// key to default it from, unlike the old format). Scope defaults to
// ScopeWorker when omitted.
//
// Unknown top-level or nested keys are rejected (strict decoding), and every
// validation rule failure is collected into a single *ValidationError rather
// than stopping at the first one.
func ParseDefinition(src []byte) (*Pipeline, error) {
	dec := yaml.NewDecoder(bytes.NewReader(src))
	dec.KnownFields(true)

	var p Pipeline
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("parse pipeline definition: %w", err)
	}
	if p.Scope == "" {
		p.Scope = ScopeWorker
	}

	if issues := validatePipelineConfig(&p); len(issues) > 0 {
		return nil, &ValidationError{Issues: issues}
	}
	return &p, nil
}

// ValidateDAG rejects a runtime Pipeline whose DependsOn + routes.when
// referenced-stages graph contains a cycle. ParseDefinition already enforces
// this (via validatePipelineConfig, which calls the same cycle detector),
// but programmatic callers that construct a Pipeline directly (tests, a
// later engine's in-process pipeline construction) bypass ParseDefinition
// and would otherwise deadlock the run silently: every cycle member stays
// pending forever because its preconditions never all reach a terminal
// state.
func ValidateDAG(p *Pipeline) error {
	cycle := FindFirstStageCycle(p.Stages)
	if cycle == nil {
		return nil
	}
	return fmt.Errorf("pipeline %q has a stage dependency cycle: %s", p.Name, strings.Join(cycle, " -> "))
}

// validatePipelineConfig runs every config-load validation rule and returns
// every issue found (nil when the config is valid).
func validatePipelineConfig(p *Pipeline) []Issue {
	var issues []Issue
	add := func(path, message string) {
		issues = append(issues, Issue{Path: path, Message: message})
	}
	addf := func(path, format string, args ...any) {
		add(path, fmt.Sprintf(format, args...))
	}

	// Rule 1: name non-empty.
	if strings.TrimSpace(p.Name) == "" {
		add("name", "name must not be empty")
	}

	// Rule 2: scope empty/worker only; other known scopes are deferred to
	// phase 2, unknown values are rejected outright.
	if p.Scope != "" && p.Scope != ScopeWorker {
		if p.Scope.IsKnown() {
			addf("scope", "scope %q is deferred to phase 2", p.Scope)
		} else {
			addf("scope", "unknown scope %q", p.Scope)
		}
	}

	// Rule 3: at least one stage; unique, non-empty stage names.
	if len(p.Stages) == 0 {
		add("stages", "pipeline must declare at least one stage")
	}
	stageNames := make(map[string]bool, len(p.Stages))
	seenNames := make(map[string]bool, len(p.Stages))
	for i, stage := range p.Stages {
		if strings.TrimSpace(stage.Name) == "" {
			add(fmt.Sprintf("stages[%d].name", i), "stage name must not be empty")
		} else {
			stageNames[stage.Name] = true
		}
		if seenNames[stage.Name] {
			addf(fmt.Sprintf("stages[%d].name", i), "duplicate stage name %q: every stage in a pipeline must have a unique name", stage.Name)
		}
		seenNames[stage.Name] = true
	}

	// Rule 6 (pipeline-level part): maxConcurrentStages >= 1.
	if p.MaxConcurrentStages != nil && *p.MaxConcurrentStages < 1 {
		add("maxConcurrentStages", "maxConcurrentStages must be >= 1")
	}

	for i, stage := range p.Stages {
		base := fmt.Sprintf("stages[%d]", i)

		// Rule 4: trigger.on values must be known v1 events.
		for j, evt := range stage.Trigger.On {
			if !evt.IsKnown() {
				addf(fmt.Sprintf("%s.trigger.on[%d]", base, j), "unknown trigger event %q", evt)
			}
		}

		// Rule 5: executor per-kind required fields + cross-kind rejection.
		issues = append(issues, validateExecutor(stage.Executor, base+".executor")...)

		// Rule 6 (stage-level): numeric bounds.
		if stage.Policy != nil && stage.Policy.StallWindow != nil && *stage.Policy.StallWindow < 0 {
			add(base+".policy.stallWindow", "stallWindow must be >= 0")
		}
		if stage.Budget != nil {
			if stage.Budget.MaxUSD != nil && *stage.Budget.MaxUSD < 0 {
				add(base+".budget.maxUsd", "maxUsd must be >= 0")
			}
			if stage.Budget.MaxDurationMs != nil && *stage.Budget.MaxDurationMs < 0 {
				add(base+".budget.maxDurationMs", "maxDurationMs must be >= 0")
			}
		}
		if stage.TimeoutMs != nil && *stage.TimeoutMs < 0 {
			add(base+".timeoutMs", "timeoutMs must be >= 0")
		}
		if stage.Retries != nil && *stage.Retries < 0 {
			add(base+".retries", "retries must be >= 0")
		}
		if stage.MaxLoopRounds != nil && *stage.MaxLoopRounds < 1 {
			add(base+".maxLoopRounds", "maxLoopRounds must be >= 1")
		}

		// Rule 7: dependsOn entries non-empty, reference known stages, no
		// self-reference.
		for _, dep := range stage.DependsOn {
			if strings.TrimSpace(dep) == "" {
				add(base+".dependsOn", "dependsOn entries must not be empty")
				continue
			}
			if dep == stage.Name {
				addf(base+".dependsOn", "Stage %q cannot depend on itself.", stage.Name)
				continue
			}
			if !stageNames[dep] {
				addf(base+".dependsOn", "Stage %q depends on unknown stage %q.", stage.Name, dep)
			}
		}

		// Rule 8: routes.when recursive predicate validation + referenced
		// stages must exist and not be the stage itself.
		if stage.Routes != nil {
			path := base + ".routes.when"
			issues = append(issues, stage.Routes.When.Validate(path)...)
			for _, ref := range stage.Routes.When.ReferencedStages() {
				if ref == stage.Name {
					addf(path, "Stage %q cannot route to itself.", stage.Name)
					continue
				}
				if !stageNames[ref] {
					addf(path, "Stage %q routes references unknown stage %q.", stage.Name, ref)
				}
			}
		}

		// Rule 10: workspace is empty, shared-ro, or isolated-rw.
		if !stage.Workspace.IsKnown() {
			addf(base+".workspace", "unknown workspace %q", stage.Workspace)
		}
	}

	// Rule 9: exitPredicates.{done,stalled,blocksMerge} recursive predicate
	// validation + referenced stages must exist.
	if p.ExitPredicates != nil {
		branches := []struct {
			key       string
			predicate *Predicate
		}{
			{"done", p.ExitPredicates.Done},
			{"stalled", p.ExitPredicates.Stalled},
			{"blocksMerge", p.ExitPredicates.BlocksMerge},
		}
		for _, branch := range branches {
			if branch.predicate == nil {
				continue
			}
			path := "exitPredicates." + branch.key
			issues = append(issues, branch.predicate.Validate(path)...)
			for _, ref := range branch.predicate.ReferencedStages() {
				if !stageNames[ref] {
					addf(path, "exitPredicates.%s references unknown stage %q.", branch.key, ref)
				}
			}
		}
	}

	// Rule 11: cycle detection, run last so structural issues above surface
	// alongside it rather than being masked by an early return.
	if cycle := FindFirstStageCycle(p.Stages); cycle != nil {
		addf("stages", "Pipeline has a stage dependency cycle: %s.", strings.Join(cycle, " -> "))
	}

	return issues
}

// executorFieldRules returns which StageExecutor fields are allowed at all
// for kind, and which of those are required. ok is false for an unknown
// kind.
func executorFieldRules(kind ExecutorKind) (allowed, required map[string]bool, ok bool) {
	switch kind {
	case ExecutorAgent:
		return map[string]bool{"plugin": true, "mode": true, "config": true},
			map[string]bool{"plugin": true, "mode": true}, true
	case ExecutorCommand:
		return map[string]bool{"command": true, "args": true, "env": true, "cwd": true},
			map[string]bool{"command": true}, true
	case ExecutorBuiltin:
		return map[string]bool{"name": true, "config": true},
			map[string]bool{"name": true}, true
	default:
		return nil, nil, false
	}
}

// executorFieldNames is the fixed order executor fields are reported in, so
// cross-kind rejection and missing-required issues come out deterministically.
var executorFieldNames = []string{
	"plugin", "mode", "command", "args", "env", "cwd", "name", "config",
}

func executorPresentFields(e StageExecutor) map[string]bool {
	return map[string]bool{
		"plugin":  e.Plugin != "",
		"mode":    e.Mode != "",
		"command": e.Command != "",
		"args":    len(e.Args) > 0,
		"env":     len(e.Env) > 0,
		"cwd":     e.Cwd != "",
		"name":    e.Name != "",
		"config":  len(e.Config) > 0,
	}
}

// validateExecutor validates a StageExecutor against its declared Kind,
// enforcing per-kind required fields and rejecting fields that belong to a
// different kind (e.g. Command set on an agent executor). Rejecting
// cross-kind fields is a deliberate improvement over the old Zod schema,
// which silently stripped unrecognized fields at the schema boundary.
func validateExecutor(e StageExecutor, path string) []Issue {
	var issues []Issue
	add := func(format string, args ...any) {
		issues = append(issues, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}

	allowed, required, ok := executorFieldRules(e.Kind)
	if !ok {
		add("unknown executor kind %q", e.Kind)
		return issues
	}

	present := executorPresentFields(e)
	for _, name := range executorFieldNames {
		if present[name] && !allowed[name] {
			add("field %q is not valid for executor kind %q", name, e.Kind)
		}
	}
	for _, name := range executorFieldNames {
		if required[name] && !present[name] {
			add("executor kind %q requires field %q", e.Kind, name)
		}
	}

	switch e.Kind {
	case ExecutorAgent:
		if e.Mode != "" && !e.Mode.IsKnown() {
			add("unknown task mode %q", e.Mode)
		}
	case ExecutorBuiltin:
		if e.Name != "" && !e.Name.IsKnown() {
			add("unknown builtin name %q", e.Name)
		}
	}

	return issues
}
