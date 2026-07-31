package pipeline

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func prSubject(number int) Subject {
	return Subject{
		Kind:      SubjectPR,
		ProjectID: "proj",
		PR:        &PRRef{Number: number, Repo: "acme/app", URL: "https://example.test/pr", HeadBranch: "feat"},
	}
}

func TestComputePlan_ReleaseExampleReachesEveryStage(t *testing.T) {
	def := mustParse(t, releaseYAML(t))

	plan, err := ComputePlan(def, prSubject(412), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if len(plan.Reachable) != releaseStageCount {
		t.Fatalf("reachable = %d stages (%v), want %d", len(plan.Reachable), plan.Reachable, releaseStageCount)
	}
	// Document order, so the entry stage comes first and the failure-path
	// stages come last.
	if plan.Reachable[0] != "prepare" {
		t.Errorf("reachable[0] = %q, want prepare", plan.Reachable[0])
	}
	if got, want := plan.Reachable, def.stageIDs(); !reflect.DeepEqual(got, want) {
		t.Errorf("reachable = %v, want document order %v", got, want)
	}
}

func TestComputePlan_EffectiveDeadlines(t *testing.T) {
	def := mustParse(t, releaseYAML(t))

	plan, err := ComputePlan(def, prSubject(412), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	// prepare declares no deadline and the pipeline declares no
	// defaults.deadline, so it inherits the 30m constant.
	if got := plan.Deadlines["prepare"]; got != DefaultStageDeadline {
		t.Errorf("prepare deadline = %v, want %v", got, DefaultStageDeadline)
	}
	if got := plan.Deadlines["build-macos"]; got != 40*time.Minute {
		t.Errorf("build-macos deadline = %v, want 40m", got)
	}
	if got := plan.Deadlines["sign-macos"]; got != 45*time.Minute {
		t.Errorf("sign-macos deadline = %v, want 45m", got)
	}
	if len(plan.Deadlines) != releaseStageCount {
		t.Errorf("deadlines cover %d stages, want %d", len(plan.Deadlines), releaseStageCount)
	}
}

func TestComputePlan_DefaultsDeadlineSitsBetween(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
defaults:
  deadline: 45m
stages:
  - id: a
    executor: command
    run: "true"
    on_success: b
  - id: b
    executor: command
    run: "true"
    deadline: 5m
`))
	plan, err := ComputePlan(def, Subject{Kind: SubjectProject, ProjectID: "proj"}, nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if got := plan.Deadlines["a"]; got != 45*time.Minute {
		t.Errorf("a deadline = %v, want the pipeline default 45m", got)
	}
	if got := plan.Deadlines["b"]; got != 5*time.Minute {
		t.Errorf("b deadline = %v, want the stage's own 5m", got)
	}
}

func TestComputePlan_ReleaseExampleWorkspaces(t *testing.T) {
	def := mustParse(t, releaseYAML(t))

	plan, err := ComputePlan(def, prSubject(412), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	want := map[string]WorkspaceKind{
		"prepare":        WorkspaceRun,
		"build-macos":    WorkspaceStage,
		"build-windows":  WorkspaceStage,
		"build-linux":    WorkspaceStage,
		"release-notes":  WorkspaceStage,
		"verify-digests": WorkspaceRun,
		"sign-macos":     WorkspaceRun,
		"publish-github": WorkspaceRun,
		"update-tap":     WorkspaceRun,
		"update-feed":    WorkspaceRun,
		"announce":       WorkspaceRun,
		"notify-failure": WorkspaceRun,
		"notify-partial": WorkspaceRun,
		// diagnose-build declares no workspace and is only ever entered via
		// a failure edge, so it stays symbolic: the tree it gets is the tree
		// of whichever build routed into it (spec section 5.4).
		"diagnose-build": WorkspaceInherit,
	}
	if !reflect.DeepEqual(plan.Workspaces, want) {
		t.Errorf("workspaces = %v,\nwant %v", plan.Workspaces, want)
	}
}

func TestComputePlan_AutoResolvesPerSubject(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: b
  - id: b
    executor: command
    run: "true"
    workspace: auto
`))

	t.Run("subject with a session", func(t *testing.T) {
		plan, err := ComputePlan(def, Subject{Kind: SubjectSession, ProjectID: "proj", SessionID: "sess-1"}, nil)
		if err != nil {
			t.Fatalf("ComputePlan: %v", err)
		}
		// Unset on a success entry defaults to auto, then resolves the same way.
		for _, id := range []string{"a", "b"} {
			if got := plan.Workspaces[id]; got != WorkspaceSession {
				t.Errorf("%s workspace = %q, want %q", id, got, WorkspaceSession)
			}
		}
	})

	t.Run("subject without a session", func(t *testing.T) {
		plan, err := ComputePlan(def, prSubject(412), nil)
		if err != nil {
			t.Fatalf("ComputePlan: %v", err)
		}
		for _, id := range []string{"a", "b"} {
			if got := plan.Workspaces[id]; got != WorkspaceRun {
				t.Errorf("%s workspace = %q, want %q", id, got, WorkspaceRun)
			}
		}
	})
}

// The one impossible combination, and the exact reason the spec section 5.3
// requires the run to state.
func TestComputePlan_SessionWorkspaceWithoutASession(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: review
    executor: agent
    agent: claude-code
    prompt: hi
    workspace: session
`))
	_, err := ComputePlan(def, prSubject(412), nil)
	if err == nil {
		t.Fatal("expected ComputePlan to fail, got nil")
	}
	const want = "stage 'review' requires workspace 'session'; PR #412 has no local session"
	if err.Error() != want {
		t.Errorf("error = %q,\nwant %q", err.Error(), want)
	}
}

func TestComputePlan_SessionWorkspaceWithASessionIsFine(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: review
    executor: agent
    agent: claude-code
    prompt: hi
    workspace: session
`))
	subject := prSubject(412)
	subject.SessionID = "sess-1"
	plan, err := ComputePlan(def, subject, nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if got := plan.Workspaces["review"]; got != WorkspaceSession {
		t.Errorf("review workspace = %q, want %q", got, WorkspaceSession)
	}
}

// An unreachable stage cannot fail the plan, because it never runs.
func TestComputePlan_UnreachableStagesAreExcluded(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: a
    executor: command
    run: "true"
  - id: orphan
    executor: command
    run: "true"
    workspace: session
`))
	plan, err := ComputePlan(def, prSubject(412), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if got, want := plan.Reachable, []string{"a"}; !reflect.DeepEqual(got, want) {
		t.Errorf("reachable = %v, want %v", got, want)
	}
	if _, ok := plan.Workspaces["orphan"]; ok {
		t.Error("unreachable stage appears in the plan")
	}
}

func TestComputePlan_NoStages(t *testing.T) {
	_, err := ComputePlan(&Pipeline{Name: "p"}, prSubject(1), nil)
	if err == nil || !strings.Contains(err.Error(), "no stages") {
		t.Fatalf("error = %v, want a no-stages error", err)
	}
}

// A stage reachable both ways defaults by its success entry: it will be
// entered with a resolvable tree at least once, and inherit would be wrong
// there.
func TestComputePlan_SuccessEntryWinsOverFailureEntry(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: a
    executor: command
    run: "true"
    on_success: cleanup
    on_failure: cleanup
  - id: cleanup
    executor: command
    run: "true"
`))
	plan, err := ComputePlan(def, prSubject(412), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if got := plan.Workspaces["cleanup"]; got != WorkspaceRun {
		t.Errorf("cleanup workspace = %q, want %q (auto resolved for a sessionless subject)", got, WorkspaceRun)
	}
}

func TestSubject_DefaultScopeAndIdentity(t *testing.T) {
	pr := prSubject(412)
	session := Subject{Kind: SubjectSession, ProjectID: "proj", SessionID: "sess-1"}
	project := Subject{Kind: SubjectProject, ProjectID: "proj"}

	tests := []struct {
		name         string
		subject      Subject
		wantScope    ConcurrencyScope
		scope        ConcurrencyScope
		wantIdentity string
	}{
		{"pr default", pr, ConcurrencyScopePR, ConcurrencyScopeUnset, "acme/app#412"},
		{"pr explicit", pr, ConcurrencyScopePR, ConcurrencyScopePR, "acme/app#412"},
		{"pr under project scope", pr, ConcurrencyScopePR, ConcurrencyScopeProject, "proj"},
		{"session default", session, ConcurrencyScopeSession, ConcurrencyScopeUnset, "sess-1"},
		{"session under project scope", session, ConcurrencyScopeSession, ConcurrencyScopeProject, "proj"},
		{"project default", project, ConcurrencyScopeProject, ConcurrencyScopeUnset, "proj"},
		{"project under pr scope has no identity", project, ConcurrencyScopeProject, ConcurrencyScopePR, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.subject.DefaultScope(); got != tc.wantScope {
				t.Errorf("DefaultScope() = %q, want %q", got, tc.wantScope)
			}
			if got := tc.subject.ScopeIdentity(tc.scope); got != tc.wantIdentity {
				t.Errorf("ScopeIdentity(%q) = %q, want %q", tc.scope, got, tc.wantIdentity)
			}
		})
	}
}

func TestSubject_HasSession(t *testing.T) {
	if (Subject{Kind: SubjectPR}).HasSession() {
		t.Error("HasSession() = true for a sessionless PR subject")
	}
	if !(Subject{Kind: SubjectPR, SessionID: "s"}).HasSession() {
		t.Error("HasSession() = false for a PR subject with a tracking session")
	}
}
