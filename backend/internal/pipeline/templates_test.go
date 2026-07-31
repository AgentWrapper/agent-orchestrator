package pipeline

import (
	"os"
	"path/filepath"
	"testing"
)

// The renderer's three "New pipeline" starter templates, checked against the
// real parser and the real validator.
//
// The templates themselves live in TypeScript
// (frontend/src/renderer/lib/pipeline-templates.ts), because they are static
// config baked into the renderer with no template API behind them. The YAML in
// testdata/templates is the serializer's output for each one, and
// pipeline-templates.test.ts asserts serializeToYaml(template.draft()) is
// byte-identical to these files. So a template edited on the TS side that stops
// satisfying a Go rule fails here, and a template edited without regenerating
// the fixture fails there. Neither side can drift quietly.
//
// A template that fails validation the moment a user clicks it is the worst
// possible first impression, and mirrored TS rules are a copy of the rules, not
// the rules.
func TestStarterTemplatesValidate(t *testing.T) {
	// Warnings are asserted, not just errors: the point is to know exactly what
	// the editor's problems panel shows on a freshly created template. Only the
	// single-stage triage template warns, and spec section 13 says that case
	// legitimately needs no failure route.
	cases := []struct {
		file         string
		stages       int
		wantWarnings []Issue
	}{
		{file: "pr-review.yaml", stages: 3},
		{
			file:   "session-idle-triage.yaml",
			stages: 1,
			wantWarnings: []Issue{{
				Path:    "defaults.on_failure",
				Message: `stage "triage" declares no on_failure and the pipeline declares no defaults.on_failure, so its failure ends the branch silently`,
			}},
		},
		{file: "release-gate.yaml", stages: 6},
	}

	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			src, err := os.ReadFile(filepath.Join("testdata", "templates", tc.file))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			// ParseDefinition is the exact path POST /pipelines/validate takes:
			// strict decode (so an unknown key is an error too) then Validate.
			p, err := ParseDefinition(src)
			if err != nil {
				t.Fatalf("template does not validate:\n%v", err)
			}
			if len(p.Stages) != tc.stages {
				t.Errorf("stage count = %d, want %d", len(p.Stages), tc.stages)
			}

			warnings, err := Validate(p)
			if err != nil {
				t.Fatalf("Validate after ParseDefinition: %v", err)
			}
			if len(warnings) != len(tc.wantWarnings) {
				t.Fatalf("warnings = %+v, want %+v", warnings, tc.wantWarnings)
			}
			for i, want := range tc.wantWarnings {
				if warnings[i] != want {
					t.Errorf("warning[%d] = %+v, want %+v", i, warnings[i], want)
				}
			}
		})
	}
}
