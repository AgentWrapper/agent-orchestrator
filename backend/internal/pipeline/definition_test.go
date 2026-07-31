package pipeline

import (
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// releaseYAML is the spec section 11 worked example, embedded verbatim as
// testdata/release.yaml. It is the canonical fixture for this package: fan-out,
// two joins, signing credentials, a diagnostic agent on the failure path.
//
// One character differs from the spec as written: notify-partial's last run
// line sits at column 0 there, below its block scalar's indent, so the spec's
// document does not parse as YAML at all. It is indented to the block indent
// here, which yields exactly the shell text the example intends (the content
// is still at relative column 0). The spec itself is left alone deliberately:
// correcting it drags the whole file through prettier, which would reformat
// 45 unrelated lines and conflict with every other v2 worker reading it.
func releaseYAML(t *testing.T) []byte {
	t.Helper()
	src, err := os.ReadFile("testdata/release.yaml")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return src
}

func mustParse(t *testing.T, src []byte) *Pipeline {
	t.Helper()
	p, err := ParseDefinition(src)
	if err != nil {
		t.Fatalf("ParseDefinition: %v", err)
	}
	return p
}

// The implementation plan says "12 stages"; the spec's own YAML declares 14
// (the plan appears to have counted the ASCII diagram, which omits
// notify-failure and notify-partial). The spec is the canonical fixture, so
// the fixture wins.
const releaseStageCount = 14

func TestParseDefinition_ReleaseExample(t *testing.T) {
	p := mustParse(t, releaseYAML(t))

	if p.Name != "release" {
		t.Errorf("name = %q, want %q", p.Name, "release")
	}
	if got, want := p.On.PR, []PREvent{PREventMerged}; !reflect.DeepEqual(got, want) {
		t.Errorf("on.pr = %v, want %v", got, want)
	}
	if len(p.On.Session) != 0 {
		t.Errorf("on.session = %v, want empty", p.On.Session)
	}
	if p.Concurrency.Scope != ConcurrencyScopeProject {
		t.Errorf("concurrency.scope = %q, want %q", p.Concurrency.Scope, ConcurrencyScopeProject)
	}
	if p.Concurrency.Group != "release" {
		t.Errorf("concurrency.group = %q, want %q", p.Concurrency.Group, "release")
	}
	if p.Concurrency.CancelInProgress {
		t.Error("concurrency.cancel-in-progress = true, want false")
	}
	if p.Defaults.OnFailure != "notify-failure" {
		t.Errorf("defaults.on_failure = %q, want %q", p.Defaults.OnFailure, "notify-failure")
	}
	if p.Defaults.Deadline != 0 {
		t.Errorf("defaults.deadline = %v, want unset", p.Defaults.Deadline)
	}

	if len(p.Stages) != releaseStageCount {
		t.Fatalf("stage count = %d, want %d", len(p.Stages), releaseStageCount)
	}

	prepare := p.StageByID("prepare")
	if prepare == nil {
		t.Fatal("StageByID(prepare) = nil")
	}
	wantFanOut := StageList{"build-macos", "build-windows", "build-linux", "release-notes"}
	if !reflect.DeepEqual(prepare.OnSuccess, wantFanOut) {
		t.Errorf("prepare.on_success = %v, want %v", prepare.OnSuccess, wantFanOut)
	}
	if prepare.Workspace != WorkspaceRun {
		t.Errorf("prepare.workspace = %q, want %q", prepare.Workspace, WorkspaceRun)
	}
	if prepare.Executor != ExecutorCommand {
		t.Errorf("prepare.executor = %q, want %q", prepare.Executor, ExecutorCommand)
	}

	verify := p.StageByID("verify-digests")
	if verify == nil {
		t.Fatal("StageByID(verify-digests) = nil")
	}
	wantNeeds := []string{"build-macos", "build-windows", "build-linux"}
	if !reflect.DeepEqual(verify.Needs, wantNeeds) {
		t.Errorf("verify-digests.needs = %v, want %v", verify.Needs, wantNeeds)
	}

	sign := p.StageByID("sign-macos")
	if sign == nil {
		t.Fatal("StageByID(sign-macos) = nil")
	}
	if got, want := sign.Credentials, []string{"apple-signing"}; !reflect.DeepEqual(got, want) {
		t.Errorf("sign-macos.credentials = %v, want %v", got, want)
	}
	if sign.Deadline != 45*time.Minute {
		t.Errorf("sign-macos.deadline = %v, want 45m", sign.Deadline)
	}

	notes := p.StageByID("release-notes")
	if notes == nil {
		t.Fatal("StageByID(release-notes) = nil")
	}
	if notes.Executor != ExecutorAgent {
		t.Errorf("release-notes.executor = %q, want %q", notes.Executor, ExecutorAgent)
	}
	if notes.Agent != "claude-code" {
		t.Errorf("release-notes.agent = %q, want %q", notes.Agent, "claude-code")
	}
	if notes.Produces != "release-notes.md" {
		t.Errorf("release-notes.produces = %q, want %q", notes.Produces, "release-notes.md")
	}
	if !strings.Contains(notes.Prompt, "ao pipeline done") {
		t.Errorf("release-notes.prompt does not mention the signal verb: %q", notes.Prompt)
	}
}

func TestPipeline_EntryStageAndStageByID(t *testing.T) {
	p := mustParse(t, releaseYAML(t))

	entry := p.EntryStage()
	if entry == nil || entry.ID != "prepare" {
		t.Fatalf("EntryStage() = %v, want prepare", entry)
	}
	if got := p.StageByID("nope"); got != nil {
		t.Errorf("StageByID(nope) = %v, want nil", got)
	}
	var empty Pipeline
	if got := empty.EntryStage(); got != nil {
		t.Errorf("EntryStage() on empty pipeline = %v, want nil", got)
	}
}

func TestStageList_ScalarOrSequence(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want StageList
	}{
		{
			name: "scalar",
			yaml: "on_success: verify-digests\n",
			want: StageList{"verify-digests"},
		},
		{
			name: "flow sequence",
			yaml: "on_success: [a, b]\n",
			want: StageList{"a", "b"},
		},
		{
			name: "block sequence",
			yaml: "on_success:\n  - a\n  - b\n",
			want: StageList{"a", "b"},
		},
		{
			name: "absent",
			yaml: "id: x\n",
			want: nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var s Stage
			if err := decodeStrict([]byte(tc.yaml), &s); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !reflect.DeepEqual(s.OnSuccess, tc.want) {
				t.Errorf("on_success = %#v, want %#v", s.OnSuccess, tc.want)
			}
		})
	}
}

func TestParseDefinition_Durations(t *testing.T) {
	p := mustParse(t, []byte(`
name: p
defaults:
  deadline: 45m
stages:
  - id: a
    executor: command
    run: "true"
    deadline: 90s
  - id: b
    executor: command
    run: "true"
`))
	if p.Defaults.Deadline != 45*time.Minute {
		t.Errorf("defaults.deadline = %v, want 45m", p.Defaults.Deadline)
	}
	if got := p.StageByID("a").Deadline; got != 90*time.Second {
		t.Errorf("a.deadline = %v, want 90s", got)
	}
	if got := p.StageByID("b").Deadline; got != 0 {
		t.Errorf("b.deadline = %v, want unset", got)
	}
}

func TestParseDefinition_RejectsUnknownKeys(t *testing.T) {
	tests := []struct {
		name string
		yaml string
	}{
		{"top level", "name: p\nnope: 1\nstages: []\n"},
		{"stage level", "name: p\nstages:\n  - id: a\n    executor: command\n    run: \"true\"\n    retries: 3\n"},
		{"defaults", "name: p\ndefaults:\n  timeout: 1m\nstages: []\n"},
		{"session", "name: p\nstages:\n  - id: a\n    executor: agent\n    agent: x\n    prompt: y\n    session:\n      keep: true\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseDefinition([]byte(tc.yaml)); err == nil {
				t.Fatal("expected a strict-decode error, got nil")
			} else if !strings.Contains(err.Error(), "field") {
				t.Errorf("expected an unknown-field error, got %v", err)
			}
		})
	}
}

func TestParseDefinition_EmptyDocument(t *testing.T) {
	_, err := ParseDefinition(nil)
	var verr *ValidationError
	if !asValidationError(err, &verr) {
		t.Fatalf("expected *ValidationError, got %v", err)
	}
	if !hasIssue(verr, "stages") {
		t.Errorf("expected a stages issue, got %v", verr.Issues)
	}
}

func TestStage_EffectiveDeadline(t *testing.T) {
	tests := []struct {
		name     string
		stage    Stage
		defaults DefaultsSpec
		want     time.Duration
	}{
		{"stage wins", Stage{Deadline: 40 * time.Minute}, DefaultsSpec{Deadline: 45 * time.Minute}, 40 * time.Minute},
		{"defaults next", Stage{}, DefaultsSpec{Deadline: 45 * time.Minute}, 45 * time.Minute},
		{"builtin default", Stage{}, DefaultsSpec{}, DefaultStageDeadline},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.stage.EffectiveDeadline(tc.defaults); got != tc.want {
				t.Errorf("EffectiveDeadline() = %v, want %v", got, tc.want)
			}
		})
	}
	if DefaultStageDeadline != 30*time.Minute {
		t.Errorf("DefaultStageDeadline = %v, want 30m", DefaultStageDeadline)
	}
}

func TestStage_EffectiveKillOn(t *testing.T) {
	p := mustParse(t, releaseYAML(t))

	// Explicit list.
	if got, want := p.StageByID("release-notes").EffectiveKillOn(), []Outcome{OutcomeSucceeded, OutcomeFailed}; !reflect.DeepEqual(got, want) {
		t.Errorf("release-notes kill-on = %v, want %v", got, want)
	}
	// Explicit empty list means never kill, and must not fall back to the default.
	if got := p.StageByID("diagnose-build").EffectiveKillOn(); len(got) != 0 {
		t.Errorf("diagnose-build kill-on = %v, want empty", got)
	}
	// No session block at all falls back to the default pair.
	if got, want := p.StageByID("prepare").EffectiveKillOn(), []Outcome{OutcomeSucceeded, OutcomeFailed}; !reflect.DeepEqual(got, want) {
		t.Errorf("prepare kill-on = %v, want %v", got, want)
	}
	// A session block with no kill-on key also falls back.
	s := Stage{Session: &SessionSpec{}}
	if got, want := s.EffectiveKillOn(), []Outcome{OutcomeSucceeded, OutcomeFailed}; !reflect.DeepEqual(got, want) {
		t.Errorf("empty session block kill-on = %v, want %v", got, want)
	}
}

// TestStage_KillsOn pins the one place the kill-on list is not matched
// literally: an author who wrote `succeeded` means the stage worked, and a
// stage with no `produces:` can only ever reach succeeded_unverified. Matching
// the two strings exactly kept a session alive after every clean run of every
// unverified stage, which the live drill showed as an orphan badge on a stage
// that had nothing wrong with it.
func TestStage_KillsOn(t *testing.T) {
	def := Stage{}
	if !def.KillsOn(OutcomeSucceededUnverified) {
		t.Error("default kill-on did not kill on succeeded_unverified")
	}
	if !def.KillsOn(OutcomeSucceeded) || !def.KillsOn(OutcomeFailed) {
		t.Error("default kill-on did not kill on its own two outcomes")
	}
	for _, kept := range []Outcome{OutcomeNoOutput, OutcomeNoSignal, OutcomeTimedOut, OutcomeCancelled} {
		if def.KillsOn(kept) {
			t.Errorf("default kill-on killed on %s, which must keep the session", kept)
		}
	}

	never := Stage{Session: &SessionSpec{KillOn: []Outcome{}}}
	if never.KillsOn(OutcomeSucceeded) || never.KillsOn(OutcomeSucceededUnverified) {
		t.Error("an explicit empty kill-on killed a session")
	}

	// The subsumption is one-way: asking for the unverified outcome alone does
	// not kill a stage that verified its artifact.
	unverifiedOnly := Stage{Session: &SessionSpec{KillOn: []Outcome{OutcomeSucceededUnverified}}}
	if unverifiedOnly.KillsOn(OutcomeSucceeded) {
		t.Error("kill-on [succeeded_unverified] killed on succeeded")
	}
	if !unverifiedOnly.KillsOn(OutcomeSucceededUnverified) {
		t.Error("kill-on [succeeded_unverified] did not kill on its own outcome")
	}
}
