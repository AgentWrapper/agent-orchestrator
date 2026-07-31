package pipeline

import (
	"errors"
	"strings"
	"testing"
)

func asValidationError(err error, target **ValidationError) bool {
	return errors.As(err, target)
}

func hasIssue(verr *ValidationError, path string) bool {
	for _, issue := range verr.Issues {
		if issue.Path == path {
			return true
		}
	}
	return false
}

func issuePaths(issues []Issue) []string {
	paths := make([]string, 0, len(issues))
	for _, issue := range issues {
		paths = append(paths, issue.Path)
	}
	return paths
}

// validateYAML decodes src (strictly) and validates it, returning the
// warnings and the *ValidationError (nil when the definition is valid).
func validateYAML(t *testing.T, src string) ([]Issue, *ValidationError) {
	t.Helper()
	var p Pipeline
	if err := decodeStrict([]byte(src), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	warnings, err := Validate(&p)
	if err == nil {
		return warnings, nil
	}
	var verr *ValidationError
	if !asValidationError(err, &verr) {
		t.Fatalf("expected *ValidationError, got %T: %v", err, err)
	}
	return warnings, verr
}

func TestValidate_ReleaseExampleIsClean(t *testing.T) {
	warnings, verr := validateYAML(t, string(releaseYAML(t)))
	if verr != nil {
		t.Fatalf("expected the spec section 11 example to validate clean, got:\n%v", verr)
	}
	if len(warnings) != 0 {
		t.Errorf("expected no warnings, got %v", issuePaths(warnings))
	}
}

func TestValidate_Rules(t *testing.T) {
	tests := []struct {
		name      string
		yaml      string
		wantPath  string
		wantInMsg string
	}{
		{
			name:      "empty stages",
			yaml:      "name: p\nstages: []\n",
			wantPath:  "stages",
			wantInMsg: "at least one stage",
		},
		{
			name: "duplicate stage id",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
  - id: a
    executor: command
    run: "true"
`,
			wantPath:  "stages[1].id",
			wantInMsg: "duplicate stage id",
		},
		{
			name: "unknown executor kind",
			yaml: `
name: p
stages:
  - id: a
    executor: wizard
`,
			wantPath:  "stages[0].executor",
			wantInMsg: "unknown executor kind",
		},
		{
			name: "missing executor kind",
			yaml: `
name: p
stages:
  - id: a
`,
			wantPath:  "stages[0].executor",
			wantInMsg: "executor is required",
		},
		{
			name: "agent stage missing agent",
			yaml: `
name: p
stages:
  - id: a
    executor: agent
    prompt: hi
`,
			wantPath:  "stages[0].agent",
			wantInMsg: "agent stage must name an agent",
		},
		{
			name: "agent stage missing prompt",
			yaml: `
name: p
stages:
  - id: a
    executor: agent
    agent: claude-code
`,
			wantPath:  "stages[0].prompt",
			wantInMsg: "agent stage must declare a prompt",
		},
		{
			name: "command stage missing run",
			yaml: `
name: p
stages:
  - id: a
    executor: command
`,
			wantPath:  "stages[0].run",
			wantInMsg: "command stage must declare a run",
		},
		{
			name: "credentials on agent stage",
			yaml: `
name: p
stages:
  - id: a
    executor: agent
    agent: claude-code
    prompt: hi
    credentials: [apple-signing]
`,
			wantPath:  "stages[0].credentials",
			wantInMsg: "command stages only",
		},
		{
			name: "produces on command stage",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    produces: out.md
`,
			wantPath:  "stages[0].produces",
			wantInMsg: "agent-stage contract",
		},
		{
			name: "produces with a path separator",
			yaml: `
name: p
stages:
  - id: a
    executor: agent
    agent: claude-code
    prompt: hi
    produces: sub/out.md
`,
			wantPath:  "stages[0].produces",
			wantInMsg: "bare filename",
		},
		{
			name: "produces with a windows path separator",
			yaml: `
name: p
stages:
  - id: a
    executor: agent
    agent: claude-code
    prompt: hi
    produces: sub\out.md
`,
			wantPath:  "stages[0].produces",
			wantInMsg: "bare filename",
		},
		{
			name: "unknown stage id in on_success",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: [b, ghost]
  - id: b
    executor: command
    run: "true"
`,
			wantPath:  "stages[0].on_success[1]",
			wantInMsg: `unknown stage id "ghost"`,
		},
		{
			name: "unknown stage id in on_failure",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_failure: ghost
`,
			wantPath:  "stages[0].on_failure",
			wantInMsg: `unknown stage id "ghost"`,
		},
		{
			name: "unknown stage id in needs",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    needs: [ghost]
`,
			wantPath:  "stages[0].needs[0]",
			wantInMsg: `unknown stage id "ghost"`,
		},
		{
			name: "unknown stage id in defaults.on_failure",
			yaml: `
name: p
defaults:
  on_failure: ghost
stages:
  - id: a
    executor: command
    run: "true"
`,
			wantPath:  "defaults.on_failure",
			wantInMsg: `unknown stage id "ghost"`,
		},
		{
			name: "cycle",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: b
    on_failure: c
  - id: b
    executor: command
    run: "true"
    on_success: a
    on_failure: c
  - id: c
    executor: command
    run: "true"
`,
			wantPath:  "stages",
			wantInMsg: "a -> b -> a",
		},
		{
			name: "cycle over a failure edge",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_failure: b
  - id: b
    executor: command
    run: "true"
    on_failure: a
`,
			wantPath:  "stages",
			wantInMsg: "a -> b -> a",
		},
		{
			name: "needs missing on a join",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: [b, c]
  - id: b
    executor: command
    run: "true"
    on_success: d
  - id: c
    executor: command
    run: "true"
    on_success: d
  - id: d
    executor: command
    run: "true"
`,
			wantPath:  "stages[3].needs",
			wantInMsg: "must declare needs",
		},
		{
			name: "needs does not match the inbound success set",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: [b, c]
  - id: b
    executor: command
    run: "true"
    on_success: d
  - id: c
    executor: command
    run: "true"
    on_success: d
  - id: d
    executor: command
    run: "true"
    needs: [b, a]
`,
			wantPath:  "stages[3].needs",
			wantInMsg: `missing ["c"], unexpected ["a"]`,
		},
		{
			name: "needs declared where there are no success edges",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
  - id: b
    executor: command
    run: "true"
    needs: [a]
`,
			wantPath:  "stages[1].needs",
			wantInMsg: `unexpected ["a"]`,
		},
		{
			name: "inherit on a join",
			yaml: `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: [b, c]
  - id: b
    executor: command
    run: "true"
    on_success: d
  - id: c
    executor: command
    run: "true"
    on_success: d
  - id: d
    executor: command
    run: "true"
    workspace: inherit
    needs: [b, c]
`,
			wantPath:  "stages[3].workspace",
			wantInMsg: "ambiguous",
		},
		{
			name: "unknown concurrency scope",
			yaml: `
name: p
concurrency:
  scope: repo
stages:
  - id: a
    executor: command
    run: "true"
`,
			wantPath:  "concurrency.scope",
			wantInMsg: `unknown concurrency scope "repo"`,
		},
		{
			name: "unknown kill-on outcome",
			yaml: `
name: p
stages:
  - id: a
    executor: agent
    agent: claude-code
    prompt: hi
    session:
      kill-on: [succeeded, exploded]
`,
			wantPath:  "stages[0].session.kill-on[1]",
			wantInMsg: `unknown outcome "exploded"`,
		},
		{
			name: "unknown pr trigger event",
			yaml: `
name: p
on:
  pr: [opened]
stages:
  - id: a
    executor: command
    run: "true"
`,
			wantPath:  "on.pr[0]",
			wantInMsg: `unknown pr event "opened"`,
		},
		{
			name: "unknown session trigger event",
			yaml: `
name: p
on:
  session: [asleep]
stages:
  - id: a
    executor: command
    run: "true"
`,
			wantPath:  "on.session[0]",
			wantInMsg: `unknown session event "asleep"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, verr := validateYAML(t, tc.yaml)
			if verr == nil {
				t.Fatalf("expected a validation error at %q, got none", tc.wantPath)
			}
			var found *Issue
			for i := range verr.Issues {
				if verr.Issues[i].Path == tc.wantPath {
					found = &verr.Issues[i]
					break
				}
			}
			if found == nil {
				t.Fatalf("no issue at %q; got %v", tc.wantPath, issuePaths(verr.Issues))
			}
			if !strings.Contains(found.Message, tc.wantInMsg) {
				t.Errorf("issue at %q = %q, want it to contain %q", tc.wantPath, found.Message, tc.wantInMsg)
			}
		})
	}
}

// A manual-only pipeline declares no trigger events at all, which is legal.
func TestValidate_ManualOnlyPipelineIsLegal(t *testing.T) {
	_, verr := validateYAML(t, `
name: p
defaults:
  on_failure: b
stages:
  - id: a
    executor: command
    run: "true"
  - id: b
    executor: command
    run: "true"
`)
	if verr != nil {
		t.Fatalf("expected a manual-only pipeline to validate, got:\n%v", verr)
	}
}

// The defaults.on_failure target may be reached from many stages without
// needing a needs key, because failure edges never join (spec section 9.2),
// and it does not self-edge (spec section 9.4).
func TestValidate_DefaultFailureTargetDoesNotSelfEdge(t *testing.T) {
	_, verr := validateYAML(t, `
name: p
defaults:
  on_failure: notify
stages:
  - id: a
    executor: command
    run: "true"
    on_success: b
  - id: b
    executor: command
    run: "true"
  - id: notify
    executor: command
    run: "true"
`)
	if verr != nil {
		t.Fatalf("expected clean validation, got:\n%v", verr)
	}
}

// A stage with one inbound success edge and several inbound failure edges does
// not need a needs key (spec section 9.2).
func TestValidate_FailureEdgesDoNotRequireNeeds(t *testing.T) {
	_, verr := validateYAML(t, `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: c
    on_failure: c
  - id: b
    executor: command
    run: "true"
    on_failure: c
  - id: c
    executor: command
    run: "true"
`)
	if verr != nil {
		t.Fatalf("expected clean validation, got:\n%v", verr)
	}
}

func TestValidate_CollectsEveryIssueInOnePass(t *testing.T) {
	_, verr := validateYAML(t, `
name: p
concurrency:
  scope: repo
stages:
  - id: a
    executor: agent
    agent: claude-code
    prompt: hi
    credentials: [x]
    produces: sub/out.md
    on_success: ghost
`)
	if verr == nil {
		t.Fatal("expected validation errors, got none")
	}
	want := []string{
		"concurrency.scope",
		"stages[0].credentials",
		"stages[0].produces",
		"stages[0].on_success[0]",
	}
	for _, path := range want {
		if !hasIssue(verr, path) {
			t.Errorf("missing issue at %q; got %v", path, issuePaths(verr.Issues))
		}
	}
	if got := verr.Error(); !strings.Contains(got, "concurrency.scope: ") {
		t.Errorf("Error() = %q, want it to render as \"path: message\" lines", got)
	}
}

func TestValidate_Warnings(t *testing.T) {
	t.Run("no failure route anywhere", func(t *testing.T) {
		warnings, verr := validateYAML(t, `
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: b
  - id: b
    executor: command
    run: "true"
`)
		if verr != nil {
			t.Fatalf("expected no errors, got:\n%v", verr)
		}
		if len(warnings) != 1 || warnings[0].Path != "defaults.on_failure" {
			t.Fatalf("warnings = %v, want one at defaults.on_failure", warnings)
		}
		if !strings.Contains(warnings[0].Message, "silently") {
			t.Errorf("warning = %q, want it to say failures end the branch silently", warnings[0].Message)
		}
	})

	// defaults.on_failure alone suppresses the warning. In practice it is the
	// only way to: without it, the last stage in the failure chain has nowhere
	// left to route, and making it route back would be a cycle.
	t.Run("no warning when defaults.on_failure is declared", func(t *testing.T) {
		warnings, verr := validateYAML(t, `
name: p
defaults:
  on_failure: notify
stages:
  - id: a
    executor: command
    run: "true"
    on_success: b
  - id: b
    executor: command
    run: "true"
  - id: notify
    executor: command
    run: "true"
`)
		if verr != nil {
			t.Fatalf("expected no errors, got:\n%v", verr)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none", issuePaths(warnings))
		}
	})

	t.Run("session workspace under a pr trigger", func(t *testing.T) {
		warnings, verr := validateYAML(t, `
name: p
on:
  pr: [updated]
defaults:
  on_failure: a
stages:
  - id: a
    executor: command
    run: "true"
    workspace: session
`)
		if verr != nil {
			t.Fatalf("expected no errors, got:\n%v", verr)
		}
		if len(warnings) != 1 || warnings[0].Path != "stages[0].workspace" {
			t.Fatalf("warnings = %v, want one at stages[0].workspace", warnings)
		}
		if !strings.Contains(warnings[0].Message, "plan time") {
			t.Errorf("warning = %q, want it to mention the plan-time failure", warnings[0].Message)
		}
	})

	t.Run("no session-workspace warning under a session trigger", func(t *testing.T) {
		warnings, verr := validateYAML(t, `
name: p
on:
  session: [idle]
defaults:
  on_failure: a
stages:
  - id: a
    executor: command
    run: "true"
    workspace: session
`)
		if verr != nil {
			t.Fatalf("expected no errors, got:\n%v", verr)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none", issuePaths(warnings))
		}
	})
}
