package pipeline

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

const fullFeaturedYAML = `
name: review-pipeline
scope: worker
maxConcurrentStages: 2
allowForkPRs: true
stages:
  - name: lint
    trigger:
      on: [pr.opened, pr.updated]
    executor:
      kind: command
      command: "make lint"
      args: ["--fix"]
      env:
        CI: "true"
      cwd: "scripts"
    task:
      prompt: "run lint"
    policy:
      blocksMerge: true
      stallWindow: 3
    budget:
      maxUsd: 1.5
      maxDurationMs: 60000
    timeoutMs: 120000
    retries: 2
    maxLoopRounds: 5
    workspace: isolated-rw
  - name: review
    trigger:
      on: [pr.opened]
    executor:
      kind: agent
      plugin: claude-code
      mode: review
      config:
        temperature: 0.2
    task:
      prompt: "review the diff"
      outputSchema:
        type: object
    dependsOn: [lint]
    workspace: shared-ro
  - name: route
    trigger:
      on: [manual]
    executor:
      kind: builtin
      name: router
      config:
        target: worker
    dependsOn: [review]
    routes:
      when:
        kind: and
        predicates:
          - kind: stage_verdict
            stage: review
            verdict: pass
          - kind: not
            predicate:
              kind: finding_count_below
              max: 0
              severity: error
exitPredicates:
  done:
    kind: all_pass
    stages: [lint, review]
  stalled:
    kind: loop_rounds_at_least
    n: 5
  blocksMerge:
    kind: or
    predicates:
      - kind: stage_verdict
        stage: review
        verdict: fail
      - kind: finding_count_below
        max: 0
        stage: review
        severity: warning
`

func TestParseDefinition_FullFeaturedRoundTrip(t *testing.T) {
	p, err := ParseDefinition([]byte(fullFeaturedYAML))
	if err != nil {
		t.Fatalf("ParseDefinition failed: %v", err)
	}

	if p.Name != "review-pipeline" {
		t.Errorf("Name = %q, want review-pipeline", p.Name)
	}
	if p.Scope != ScopeWorker {
		t.Errorf("Scope = %q, want worker", p.Scope)
	}
	if p.MaxConcurrentStages == nil || *p.MaxConcurrentStages != 2 {
		t.Errorf("MaxConcurrentStages = %v, want 2", p.MaxConcurrentStages)
	}
	if p.AllowForkPRs == nil || !*p.AllowForkPRs {
		t.Errorf("AllowForkPRs = %v, want true", p.AllowForkPRs)
	}
	if len(p.Stages) != 3 {
		t.Fatalf("len(Stages) = %d, want 3", len(p.Stages))
	}

	lint := p.Stages[0]
	if lint.Name != "lint" {
		t.Errorf("Stages[0].Name = %q, want lint", lint.Name)
	}
	if lint.Executor.Kind != ExecutorCommand || lint.Executor.Command != "make lint" {
		t.Errorf("lint.Executor = %+v", lint.Executor)
	}
	if len(lint.Executor.Args) != 1 || lint.Executor.Args[0] != "--fix" {
		t.Errorf("lint.Executor.Args = %v", lint.Executor.Args)
	}
	if lint.Executor.Env["CI"] != "true" {
		t.Errorf("lint.Executor.Env = %v", lint.Executor.Env)
	}
	if lint.Executor.Cwd != "scripts" {
		t.Errorf("lint.Executor.Cwd = %q", lint.Executor.Cwd)
	}
	if lint.Policy == nil || lint.Policy.BlocksMerge == nil || !*lint.Policy.BlocksMerge {
		t.Errorf("lint.Policy.BlocksMerge = %+v", lint.Policy)
	}
	if lint.Policy == nil || lint.Policy.StallWindow == nil || *lint.Policy.StallWindow != 3 {
		t.Errorf("lint.Policy.StallWindow = %+v", lint.Policy)
	}
	if lint.Budget == nil || lint.Budget.MaxUSD == nil || *lint.Budget.MaxUSD != 1.5 {
		t.Errorf("lint.Budget.MaxUSD = %+v", lint.Budget)
	}
	if lint.Budget == nil || lint.Budget.MaxDurationMs == nil || *lint.Budget.MaxDurationMs != 60000 {
		t.Errorf("lint.Budget.MaxDurationMs = %+v", lint.Budget)
	}
	if lint.TimeoutMs == nil || *lint.TimeoutMs != 120000 {
		t.Errorf("lint.TimeoutMs = %v", lint.TimeoutMs)
	}
	if lint.Retries == nil || *lint.Retries != 2 {
		t.Errorf("lint.Retries = %v", lint.Retries)
	}
	if lint.MaxLoopRounds == nil || *lint.MaxLoopRounds != 5 {
		t.Errorf("lint.MaxLoopRounds = %v", lint.MaxLoopRounds)
	}
	if lint.Workspace != WorkspaceIsolatedRW {
		t.Errorf("lint.Workspace = %q", lint.Workspace)
	}

	review := p.Stages[1]
	if review.Executor.Kind != ExecutorAgent || review.Executor.Plugin != "claude-code" || review.Executor.Mode != ModeReview {
		t.Errorf("review.Executor = %+v", review.Executor)
	}
	if review.Executor.Config["temperature"] != 0.2 {
		t.Errorf("review.Executor.Config = %v", review.Executor.Config)
	}
	if len(review.DependsOn) != 1 || review.DependsOn[0] != "lint" {
		t.Errorf("review.DependsOn = %v", review.DependsOn)
	}
	if review.Workspace != WorkspaceSharedRO {
		t.Errorf("review.Workspace = %q", review.Workspace)
	}

	route := p.Stages[2]
	if route.Executor.Kind != ExecutorBuiltin || route.Executor.Name != BuiltinRouter {
		t.Errorf("route.Executor = %+v", route.Executor)
	}
	if len(route.DependsOn) != 1 || route.DependsOn[0] != "review" {
		t.Errorf("route.DependsOn = %v", route.DependsOn)
	}
	if route.Routes == nil || route.Routes.When.Kind != PredicateAnd || len(route.Routes.When.Predicates) != 2 {
		t.Fatalf("route.Routes = %+v", route.Routes)
	}
	if route.Routes.When.Predicates[1].Kind != PredicateNot ||
		route.Routes.When.Predicates[1].Predicate.Kind != PredicateFindingCountBelow {
		t.Errorf("route.Routes.When.Predicates[1] = %+v", route.Routes.When.Predicates[1])
	}

	if p.ExitPredicates == nil {
		t.Fatal("ExitPredicates is nil")
	}
	if p.ExitPredicates.Done == nil || p.ExitPredicates.Done.Kind != PredicateAllPass ||
		len(p.ExitPredicates.Done.Stages) != 2 {
		t.Errorf("ExitPredicates.Done = %+v", p.ExitPredicates.Done)
	}
	if p.ExitPredicates.Stalled == nil || p.ExitPredicates.Stalled.Kind != PredicateLoopRoundsAtLeast ||
		p.ExitPredicates.Stalled.N == nil || *p.ExitPredicates.Stalled.N != 5 {
		t.Errorf("ExitPredicates.Stalled = %+v", p.ExitPredicates.Stalled)
	}
	if p.ExitPredicates.BlocksMerge == nil || p.ExitPredicates.BlocksMerge.Kind != PredicateOr ||
		len(p.ExitPredicates.BlocksMerge.Predicates) != 2 {
		t.Errorf("ExitPredicates.BlocksMerge = %+v", p.ExitPredicates.BlocksMerge)
	}

	// JSON marshal/unmarshal round trip (T3 stores JSON snapshots).
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var roundTripped Pipeline
	if err := json.Unmarshal(data, &roundTripped); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if !reflect.DeepEqual(*p, roundTripped) {
		t.Fatalf("JSON round trip mismatch:\noriginal:     %+v\nround-tripped: %+v", *p, roundTripped)
	}
}

func TestParseDefinition_Invalid(t *testing.T) {
	base := func(body string) string {
		return "name: p\nstages:\n" + body
	}
	simpleStage := `  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
`

	cases := []struct {
		name        string
		yaml        string
		wantPathSub string
		wantMsgSub  string
	}{
		{
			name:        "missing name",
			yaml:        "stages:\n" + simpleStage,
			wantPathSub: "name",
			wantMsgSub:  "must not be empty",
		},
		{
			name:        "bad scope (deferred to phase 2)",
			yaml:        "name: p\nscope: orchestrator\nstages:\n" + simpleStage,
			wantPathSub: "scope",
			wantMsgSub:  "deferred to phase 2",
		},
		{
			name:        "bad scope (unknown value)",
			yaml:        "name: p\nscope: bogus\nstages:\n" + simpleStage,
			wantPathSub: "scope",
			wantMsgSub:  "unknown scope",
		},
		{
			name:        "empty stages",
			yaml:        "name: p\nstages: []\n",
			wantPathSub: "stages",
			wantMsgSub:  "at least one stage",
		},
		{
			name: "duplicate stage name",
			yaml: base(simpleStage + `  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
`),
			wantPathSub: "stages[1].name",
			wantMsgSub:  "duplicate stage name",
		},
		{
			name: "unknown trigger event",
			yaml: base(`  - name: s1
    trigger:
      on: [bogus.event]
    executor:
      kind: command
      command: "echo hi"
`),
			wantPathSub: "trigger.on",
			wantMsgSub:  "unknown trigger event",
		},
		{
			name: "unknown executor kind",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: bogus
`),
			wantPathSub: "executor",
			wantMsgSub:  "unknown executor kind",
		},
		{
			name: "agent missing plugin/mode",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: agent
`),
			wantPathSub: "executor",
			wantMsgSub:  "requires field",
		},
		{
			name: "agent with command field set (cross-kind)",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: agent
      plugin: claude-code
      mode: review
      command: "echo hi"
`),
			wantPathSub: "executor",
			wantMsgSub:  `not valid for executor kind "agent"`,
		},
		{
			name: "command missing command",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
`),
			wantPathSub: "executor",
			wantMsgSub:  "requires field",
		},
		{
			name: "builtin bad name",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: builtin
      name: bogus
`),
			wantPathSub: "executor",
			wantMsgSub:  "unknown builtin name",
		},
		{
			name: "negative retries",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    retries: -1
`),
			wantPathSub: "retries",
			wantMsgSub:  "must be >= 0",
		},
		{
			name: "maxLoopRounds 0",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    maxLoopRounds: 0
`),
			wantPathSub: "maxLoopRounds",
			wantMsgSub:  "must be >= 1",
		},
		{
			name: "unknown dependsOn",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    dependsOn: [ghost]
`),
			wantPathSub: "dependsOn",
			wantMsgSub:  `depends on unknown stage "ghost"`,
		},
		{
			name: "self dependsOn",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    dependsOn: [s1]
`),
			wantPathSub: "dependsOn",
			wantMsgSub:  "cannot depend on itself",
		},
		{
			name: "routes references unknown stage",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    routes:
      when:
        kind: stage_verdict
        stage: ghost
        verdict: pass
`),
			wantPathSub: "routes.when",
			wantMsgSub:  `routes references unknown stage "ghost"`,
		},
		{
			name: "routes self-reference",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    routes:
      when:
        kind: stage_verdict
        stage: s1
        verdict: pass
`),
			wantPathSub: "routes.when",
			wantMsgSub:  "cannot route to itself",
		},
		{
			name: "exitPredicates references unknown stage",
			yaml: base(simpleStage) + `exitPredicates:
  done:
    kind: stage_verdict
    stage: ghost
    verdict: pass
`,
			wantPathSub: "exitPredicates.done",
			wantMsgSub:  `references unknown stage "ghost"`,
		},
		{
			name: "bad workspace",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    workspace: bogus
`),
			wantPathSub: "workspace",
			wantMsgSub:  "unknown workspace",
		},
		{
			name:       "unknown top-level YAML key",
			yaml:       "name: p\nbogusTopLevel: true\nstages:\n" + simpleStage,
			wantMsgSub: "bogusTopLevel",
		},
		{
			name: "unknown stage key",
			yaml: base(`  - name: s1
    trigger:
      on: [manual]
    executor:
      kind: command
      command: "echo hi"
    bogusStageKey: true
`),
			wantMsgSub: "bogusStageKey",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseDefinition([]byte(tc.yaml))
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantMsgSub) {
				t.Fatalf("error %q does not contain %q", err.Error(), tc.wantMsgSub)
			}
			if tc.wantPathSub != "" {
				var verr *ValidationError
				ok := asValidationError(err, &verr)
				if !ok {
					t.Fatalf("expected *ValidationError, got %T: %v", err, err)
				}
				var found bool
				for _, issue := range verr.Issues {
					if strings.Contains(issue.Path, tc.wantPathSub) && strings.Contains(issue.Message, tc.wantMsgSub) {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("no issue matched path substring %q / message substring %q; got %+v",
						tc.wantPathSub, tc.wantMsgSub, verr.Issues)
				}
			}
		})
	}
}

// asValidationError is a small errors.As shim kept local to the test so the
// table above stays readable.
func asValidationError(err error, target **ValidationError) bool {
	return errors.As(err, target)
}

func TestParseDefinition_MultipleIssuesSurfaceTogether(t *testing.T) {
	yaml := "stages: []\n"
	_, err := ParseDefinition([]byte(yaml))
	if err == nil {
		t.Fatal("expected error")
	}
	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("expected *ValidationError, got %T: %v", err, err)
	}
	if len(verr.Issues) < 2 {
		t.Fatalf("expected at least 2 issues (missing name + empty stages), got %+v", verr.Issues)
	}
	var sawName, sawStages bool
	for _, issue := range verr.Issues {
		if issue.Path == "name" {
			sawName = true
		}
		if issue.Path == "stages" {
			sawStages = true
		}
	}
	if !sawName || !sawStages {
		t.Fatalf("expected issues at both 'name' and 'stages', got %+v", verr.Issues)
	}
}

func TestValidateDAG(t *testing.T) {
	t.Run("acyclic passes", func(t *testing.T) {
		p := &Pipeline{
			Name: "p",
			Stages: []Stage{
				{Name: "a"},
				{Name: "b", DependsOn: []string{"a"}},
			},
		}
		if err := ValidateDAG(p); err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
	})

	t.Run("cyclic fails", func(t *testing.T) {
		p := &Pipeline{
			Name: "p",
			Stages: []Stage{
				{Name: "a", DependsOn: []string{"b"}},
				{Name: "b", DependsOn: []string{"a"}},
			},
		}
		err := ValidateDAG(p)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "a -> b -> a") {
			t.Fatalf("error %q missing cycle path", err.Error())
		}
	})
}
