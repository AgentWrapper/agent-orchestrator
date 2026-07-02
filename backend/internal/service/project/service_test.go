package project_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// newManager builds a Manager over a real, throwaway sqlite store (pure-Go
// driver, migrations run on Open) — no in-memory store.
func newManager(t *testing.T) project.Manager {
	t.Helper()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return project.New(store)
}

// gitRepo creates a real git repository in a fresh temp dir and returns its
// path. It pins the initial branch to `main` so default-branch detection is
// deterministic regardless of the host's init.defaultBranch.
func gitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("git unavailable: %v (%s)", err, out)
	}
	return dir
}

// gitRepoOnBranch creates a real git repository whose initial branch is
// `branch`, used to exercise default-branch detection for non-`main` repos.
func gitRepoOnBranch(t *testing.T, branch string) string {
	t.Helper()
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", "-b", branch, dir).CombinedOutput(); err != nil {
		t.Fatalf("git unavailable: %v (%s)", err, out)
	}
	return dir
}

// gitRepoWithOriginHead creates a repo whose remote default (origin/HEAD) points
// at defaultBranch while the working tree is checked out on featureBranch. This
// mirrors a user adding a project while sitting on a feature branch: detection
// must record the remote default, not the active branch.
func gitRepoWithOriginHead(t *testing.T, defaultBranch, featureBranch string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	if out, err := exec.Command("git", "init", "-b", defaultBranch, dir).CombinedOutput(); err != nil {
		t.Fatalf("git unavailable: %v (%s)", err, out)
	}
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	run("commit", "--allow-empty", "-m", "init")
	// Fabricate a remote-tracking default without a real remote: point
	// refs/remotes/origin/<defaultBranch> at HEAD, then set origin/HEAD to it.
	run("update-ref", "refs/remotes/origin/"+defaultBranch, "HEAD")
	run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/"+defaultBranch)
	run("checkout", "-b", featureBranch)
	return dir
}

func ptr(s string) *string { return &s }

// wantCode asserts err is an *apierr.Error carrying the given machine code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *apierr.Error
	if !errors.As(err, &e) {
		t.Fatalf("error = %v, want *apierr.Error", err)
	}
	if e.Code != code {
		t.Fatalf("code = %q, want %q", e.Code, code)
	}
}

type fakeProjectTeardowner struct {
	projects []domain.ProjectID
	err      error
}

type captureSink struct {
	events []ports.TelemetryEvent
}

func (s *captureSink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	s.events = append(s.events, ev)
}

func (*captureSink) Close(context.Context) error { return nil }

func (f *fakeProjectTeardowner) TeardownProject(_ context.Context, project domain.ProjectID) error {
	f.projects = append(f.projects, project)
	return f.err
}

func TestManager_AddListGetRemove(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepo(t)

	if got, err := m.List(ctx); err != nil || len(got) != 0 {
		t.Fatalf("List() = %v, %v; want empty", got, err)
	}

	proj, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao"), Name: ptr("Agent Orchestrator")})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if proj.ID != "ao" || proj.Name != "Agent Orchestrator" || proj.Path != repo || proj.DefaultBranch != "main" {
		t.Fatalf("Add returned %#v", proj)
	}

	list, err := m.List(ctx)
	if err != nil || len(list) != 1 || list[0].ID != "ao" {
		t.Fatalf("List() = %v, %v; want [ao]", list, err)
	}

	res, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if res.Status != "ok" || res.Project == nil || res.Project.ID != "ao" {
		t.Fatalf("Get = %#v", res)
	}

	rm, err := m.Remove(ctx, "ao")
	if err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if rm.ProjectID != "ao" || rm.RemovedStorageDir {
		t.Fatalf("Remove = %#v", rm)
	}
	if list, _ := m.List(ctx); len(list) != 0 {
		t.Fatalf("active list after remove = %d, want 0", len(list))
	}
	_, err = m.Get(ctx, "ao")
	wantCode(t, err, "PROJECT_NOT_FOUND")

	_, err = m.Remove(ctx, "ao")
	wantCode(t, err, "PROJECT_NOT_FOUND")
}

func TestManager_AddEmitsProjectAndFirstProjectTelemetry(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	sink := &captureSink{}
	m := project.NewWithDeps(project.Deps{Store: store, Telemetry: sink})

	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if len(sink.events) != 2 {
		t.Fatalf("events = %#v, want projects.created + first_project_added", sink.events)
	}
	if sink.events[0].Name != "ao.projects.created" || sink.events[1].Name != "ao.onboarding.first_project_added" {
		t.Fatalf("event names = %#v", []string{sink.events[0].Name, sink.events[1].Name})
	}
}

func TestManager_AddDoesNotRepeatFirstProjectTelemetry(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	sink := &captureSink{}
	m := project.NewWithDeps(project.Deps{Store: store, Telemetry: sink})

	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add first: %v", err)
	}
	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao2")}); err != nil {
		t.Fatalf("Add second: %v", err)
	}
	var firstProjectCount int
	for _, ev := range sink.events {
		if ev.Name == "ao.onboarding.first_project_added" {
			firstProjectCount++
		}
	}
	if firstProjectCount != 1 {
		t.Fatalf("first project telemetry count = %d, want 1", firstProjectCount)
	}
}

func TestManager_RemoveTeardownsBeforeArchive(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	teardown := &fakeProjectTeardowner{}
	m := project.NewWithDeps(project.Deps{Store: store, Sessions: teardown})

	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := m.Remove(ctx, "ao"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(teardown.projects) != 1 || teardown.projects[0] != "ao" {
		t.Fatalf("teardown projects = %#v, want [ao]", teardown.projects)
	}
	_, err = m.Get(ctx, "ao")
	wantCode(t, err, "PROJECT_NOT_FOUND")
}

func TestManager_RemoveDoesNotArchiveWhenTeardownFails(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	boom := errors.New("teardown failed")
	m := project.NewWithDeps(project.Deps{Store: store, Sessions: &fakeProjectTeardowner{err: boom}})

	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := m.Remove(ctx, "ao"); !errors.Is(err, boom) {
		t.Fatalf("Remove err = %v, want teardown failure", err)
	}
	if got, err := m.Get(ctx, "ao"); err != nil || got.Project == nil || got.Project.ID != "ao" {
		t.Fatalf("project after failed remove = %#v, %v; want still active", got, err)
	}
}

func TestManager_DefaultsWhenUnconfigured(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepo(t)

	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	// Get on a project that set no config still reports the default branch and a
	// derived session prefix, and omits the (empty) config object.
	got, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Project == nil {
		t.Fatalf("Get returned no project: %#v", got)
	}
	if got.Project.DefaultBranch != domain.DefaultBranchName {
		t.Fatalf("default branch = %q, want %q", got.Project.DefaultBranch, domain.DefaultBranchName)
	}
	if got.Project.Agent != "claude-code" {
		t.Fatalf("default agent = %q, want claude-code", got.Project.Agent)
	}
	if got.Project.Config != nil {
		t.Fatalf("unconfigured project should omit config, got %#v", got.Project.Config)
	}

	list, err := m.List(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	if list[0].SessionPrefix != "ao" {
		t.Fatalf("default session prefix = %q, want derived 'ao'", list[0].SessionPrefix)
	}
}

func TestManager_GetUsesConfiguredDefaultHarness(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	m := project.NewWithDeps(project.Deps{Store: store, DefaultHarness: domain.HarnessCodex})
	repo := gitRepo(t)

	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	got, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Project == nil {
		t.Fatalf("Get returned no project: %#v", got)
	}
	if got.Project.Agent != "codex" {
		t.Fatalf("default agent = %q, want codex", got.Project.Agent)
	}
}

func TestManager_AddDetectsNonMainDefaultBranch(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepoOnBranch(t, "master")

	proj, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	// A repo whose checked-out branch is not `main` must record that branch so
	// session worktrees base off a ref that exists (otherwise spawn fails
	// BRANCH_NOT_FETCHED).
	if proj.DefaultBranch != "master" {
		t.Fatalf("DefaultBranch = %q, want master", proj.DefaultBranch)
	}

	got, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Project == nil || got.Project.DefaultBranch != "master" {
		t.Fatalf("Get DefaultBranch = %#v, want master", got.Project)
	}

	// An explicit config wins over detection.
	mainRepo := gitRepoOnBranch(t, "trunk")
	proj2, err := m.Add(ctx, project.AddInput{
		Path:      mainRepo,
		ProjectID: ptr("ao2"),
		Config:    &domain.ProjectConfig{DefaultBranch: "release"},
	})
	if err != nil {
		t.Fatalf("Add with config: %v", err)
	}
	if proj2.DefaultBranch != "release" {
		t.Fatalf("explicit DefaultBranch = %q, want release", proj2.DefaultBranch)
	}
}

// A repo checked out on a feature branch must NOT record that branch as the
// project default — detection must prefer the remote default (origin/HEAD), so a
// repo whose origin/HEAD is `main` stays on `main` even when HEAD is elsewhere.
func TestManager_AddPrefersOriginHeadOverCheckedOutBranch(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepoWithOriginHead(t, "main", "fix/pr-attachment")

	proj, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	// origin/HEAD is `main`, which equals DefaultBranchName, so config stays empty
	// and the effective default resolves to main — never the feature branch.
	if proj.DefaultBranch != domain.DefaultBranchName {
		t.Fatalf("DefaultBranch = %q, want %q (not the checked-out feature branch)",
			proj.DefaultBranch, domain.DefaultBranchName)
	}
}

// When origin/HEAD points at a non-main default (e.g. master), detection records
// that — not the feature branch the user happens to be on.
func TestManager_AddPrefersOriginHeadNonMain(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepoWithOriginHead(t, "master", "fix/pr-attachment")

	proj, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if proj.DefaultBranch != "master" {
		t.Fatalf("DefaultBranch = %q, want master (origin/HEAD), not feature branch", proj.DefaultBranch)
	}
}

func TestManager_SetConfig(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepo(t)

	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	cfg := domain.ProjectConfig{
		DefaultBranch: "develop",
		Env:           map[string]string{"FOO": "bar"},
		AgentConfig:   domain.AgentConfig{Model: "claude-opus-4-5"},
	}
	proj, err := m.SetConfig(ctx, "ao", project.SetConfigInput{Config: cfg})
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if proj.Config == nil || proj.Config.AgentConfig.Model != "claude-opus-4-5" {
		t.Fatalf("returned config = %#v", proj.Config)
	}
	if proj.DefaultBranch != "develop" {
		t.Fatalf("DefaultBranch = %q, want develop", proj.DefaultBranch)
	}

	// The config persists and shows up on a fresh Get.
	got, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Project == nil || got.Project.Config == nil || got.Project.Config.Env["FOO"] != "bar" {
		t.Fatalf("Get config = %#v", got.Project)
	}

	// An invalid permission value is rejected when set.
	_, err = m.SetConfig(ctx, "ao", project.SetConfigInput{Config: domain.ProjectConfig{AgentConfig: domain.AgentConfig{Permissions: "yolo"}}})
	wantCode(t, err, "INVALID_PROJECT_CONFIG")

	// An unknown role-override harness is rejected too.
	_, err = m.SetConfig(ctx, "ao", project.SetConfigInput{Config: domain.ProjectConfig{Worker: domain.RoleOverride{Harness: "nope"}}})
	wantCode(t, err, "INVALID_PROJECT_CONFIG")

	// Setting on an unknown project is a clean not-found.
	_, err = m.SetConfig(ctx, "ghost", project.SetConfigInput{Config: cfg})
	wantCode(t, err, "PROJECT_NOT_FOUND")
}

func TestManager_ReaddAfterRemove(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepo(t)

	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	if _, err := m.Remove(ctx, "ao"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("ao2")}); err != nil {
		t.Fatalf("re-add same path after remove: %v", err)
	}

	otherRepo := gitRepo(t)
	if _, err := m.Remove(ctx, "ao2"); err != nil {
		t.Fatalf("Remove ao2: %v", err)
	}
	if _, err := m.Add(ctx, project.AddInput{Path: otherRepo, ProjectID: ptr("ao2")}); err != nil {
		t.Fatalf("re-add same id at different path after remove: %v", err)
	}
}

func TestManager_AddValidationAndConflicts(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)

	_, err := m.Add(ctx, project.AddInput{Path: ""})
	wantCode(t, err, "PATH_REQUIRED")

	_, err = m.Add(ctx, project.AddInput{Path: t.TempDir()}) // exists but not a git repo
	wantCode(t, err, "NOT_A_GIT_REPO")

	// An embedded ".." passes the id pattern but would yield an invalid git
	// branch (ao/a..b-1) at spawn time; reject it up front as a clear 400.
	_, err = m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("a..b")})
	wantCode(t, err, "INVALID_PROJECT_ID")

	repoA, repoB := gitRepo(t), gitRepo(t)
	if _, err := m.Add(ctx, project.AddInput{Path: repoA, ProjectID: ptr("shared")}); err != nil {
		t.Fatalf("seed add: %v", err)
	}
	_, err = m.Add(ctx, project.AddInput{Path: repoA, ProjectID: ptr("other")})
	wantCode(t, err, "PATH_ALREADY_REGISTERED")

	_, err = m.Add(ctx, project.AddInput{Path: repoB, ProjectID: ptr("shared")})
	wantCode(t, err, "ID_ALREADY_REGISTERED")
}

// gitRepoWithOrigin creates a real git repo with an `origin` remote pointing
// at `originURL`. Used to assert project.Add captures the origin at add time.
func gitRepoWithOrigin(t *testing.T, originURL string) string {
	t.Helper()
	dir := gitRepo(t)
	if out, err := exec.Command("git", "-C", dir, "remote", "add", "origin", originURL).CombinedOutput(); err != nil {
		t.Fatalf("git remote add: %v (%s)", err, out)
	}
	return dir
}

func TestManager_AddPopulatesRepoOriginURL(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name    string
		setup   func(t *testing.T) string
		wantURL string
	}{
		{
			name:    "git repo with origin populates url",
			setup:   func(t *testing.T) string { return gitRepoWithOrigin(t, "https://github.com/o/r.git") },
			wantURL: "https://github.com/o/r.git",
		},
		{
			name:    "git repo without origin leaves url empty",
			setup:   func(t *testing.T) string { return gitRepo(t) },
			wantURL: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newManager(t)
			path := tc.setup(t)
			proj, err := m.Add(ctx, project.AddInput{Path: path, ProjectID: ptr("p")})
			if err != nil {
				t.Fatalf("Add: %v", err)
			}
			if proj.Repo != tc.wantURL {
				t.Fatalf("Repo = %q, want %q", proj.Repo, tc.wantURL)
			}
		})
	}
}

func TestManager_GetUpdateRemoveErrors(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)

	_, err := m.Get(ctx, "nope")
	wantCode(t, err, "PROJECT_NOT_FOUND")

	_, err = m.Get(ctx, domain.ProjectID("bad/id"))
	wantCode(t, err, "INVALID_PROJECT_ID")

	_, err = m.Remove(ctx, "nope")
	wantCode(t, err, "PROJECT_NOT_FOUND")

	repo := gitRepo(t)
	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: ptr("p")}); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func configureCommitter(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_AUTHOR_NAME", "AO Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "ao@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "AO Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "ao@example.com")
}

func gitRepoWithCommit(t *testing.T, dir string) string {
	t.Helper()
	if out, err := exec.Command("git", "init", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	if out, err := exec.Command("git", "-C", dir, "add", "README.md").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v (%s)", err, out)
	}
	if out, err := exec.Command("git", "-C", dir, "commit", "-m", "initial").CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v (%s)", err, out)
	}
	return dir
}

func TestManager_AddWorkspaceInitializesPlainParent(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)
	parent := t.TempDir()
	if err := os.WriteFile(filepath.Join(parent, "package.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRepoWithCommit(t, filepath.Join(parent, "cli"))
	gitRepoWithCommit(t, filepath.Join(parent, "api"))

	proj, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("ws"), AsWorkspace: true})
	if err != nil {
		t.Fatalf("Add workspace: %v", err)
	}
	if proj.Kind != domain.ProjectKindWorkspace {
		t.Fatalf("Kind = %q, want workspace", proj.Kind)
	}
	if len(proj.WorkspaceRepos) != 2 || proj.WorkspaceRepos[0].Name != "api" || proj.WorkspaceRepos[1].Name != "cli" {
		t.Fatalf("WorkspaceRepos = %#v", proj.WorkspaceRepos)
	}
	ignored, err := os.ReadFile(filepath.Join(parent, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"/api/", "/cli/", "node_modules/", "dist/"} {
		if !strings.Contains(string(ignored), want) {
			t.Fatalf(".gitignore missing %q:\n%s", want, ignored)
		}
	}
	out, err := exec.Command("git", "-C", parent, "ls-files", "-s").CombinedOutput()
	if err != nil {
		t.Fatalf("git ls-files: %v (%s)", err, out)
	}
	if strings.Contains(string(out), "160000") {
		t.Fatalf("parent tracked a child repo as a gitlink:\n%s", out)
	}
	if !strings.Contains(string(out), "package.json") || !strings.Contains(string(out), ".gitignore") {
		t.Fatalf("parent root files not committed:\n%s", out)
	}

	got, err := m.Get(ctx, "ws")
	if err != nil {
		t.Fatalf("Get workspace: %v", err)
	}
	if got.Project == nil || got.Project.Kind != domain.ProjectKindWorkspace || len(got.Project.WorkspaceRepos) != 2 {
		t.Fatalf("Get = %#v", got)
	}
}

func TestManager_AddWorkspaceRejectsUncommittedChild(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)
	parent := t.TempDir()
	child := filepath.Join(parent, "cli")
	if out, err := exec.Command("git", "init", "-b", "main", child).CombinedOutput(); err != nil {
		t.Fatalf("git init child: %v (%s)", err, out)
	}

	_, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("ws"), AsWorkspace: true})
	wantCode(t, err, "WORKSPACE_CHILD_UNBORN")
}

// TestManager_AddWorkspaceAdoptsExistingParent verifies that when the parent is
// already a git repo, Add commits only .gitignore changes, preserves the prior
// commit history, and registers the children.
func TestManager_AddWorkspaceAdoptsExistingParent(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	parent := t.TempDir()
	// Parent is an existing repo with one commit and a pre-existing .gitignore.
	gitRepoWithCommit(t, parent)
	if err := os.WriteFile(filepath.Join(parent, ".gitignore"), []byte("*.log\n"), 0o644); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}
	if out, err := exec.Command("git", "-C", parent, "add", ".gitignore").CombinedOutput(); err != nil {
		t.Fatalf("git add .gitignore: %v (%s)", err, out)
	}
	if out, err := exec.Command("git", "-C", parent, "commit", "-m", "add gitignore").CombinedOutput(); err != nil {
		t.Fatalf("git commit .gitignore: %v (%s)", err, out)
	}

	gitRepoWithCommit(t, filepath.Join(parent, "api"))
	gitRepoWithCommit(t, filepath.Join(parent, "backend"))

	proj, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("ws2"), AsWorkspace: true})
	if err != nil {
		t.Fatalf("Add workspace: %v", err)
	}
	if proj.Kind != domain.ProjectKindWorkspace {
		t.Fatalf("Kind = %q, want workspace", proj.Kind)
	}
	if len(proj.WorkspaceRepos) != 2 {
		t.Fatalf("WorkspaceRepos = %#v, want 2", proj.WorkspaceRepos)
	}

	// Original .gitignore line must be preserved.
	ignored, err := os.ReadFile(filepath.Join(parent, ".gitignore"))
	if err != nil {
		t.Fatalf("read .gitignore: %v", err)
	}
	if !strings.Contains(string(ignored), "*.log") {
		t.Fatalf(".gitignore lost original line; got:\n%s", ignored)
	}
	for _, want := range []string{"/api/", "/backend/"} {
		if !strings.Contains(string(ignored), want) {
			t.Fatalf(".gitignore missing %q:\n%s", want, ignored)
		}
	}

	// Exactly one new commit must have been created, touching only .gitignore.
	logOut, err := exec.Command("git", "-C", parent, "log", "--format=%s").CombinedOutput()
	if err != nil {
		t.Fatalf("git log: %v (%s)", err, logOut)
	}
	lines := strings.Split(strings.TrimSpace(string(logOut)), "\n")
	// Expect: AO workspace commit + "add gitignore" + "initial" = 3 commits.
	if len(lines) != 3 {
		t.Fatalf("expected 3 commits, got %d:\n%s", len(lines), logOut)
	}

	showOut, err := exec.Command("git", "-C", parent, "show", "--name-only", "--format=", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("git show HEAD: %v (%s)", err, showOut)
	}
	files := strings.TrimSpace(string(showOut))
	if files != ".gitignore" {
		t.Fatalf("HEAD touched files other than .gitignore: %q", files)
	}
}

// TestManager_AddWorkspaceRejectsWorktreeParent verifies that a linked worktree
// of another repository is rejected as a workspace parent.
func TestManager_AddWorkspaceRejectsWorktreeParent(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	base := t.TempDir()
	mainRepo := filepath.Join(base, "main")
	wtDir := filepath.Join(base, "wt")
	gitRepoWithCommit(t, mainRepo)

	// Create a linked worktree from the main repo.
	if out, err := exec.Command("git", "-C", mainRepo, "worktree", "add", wtDir).CombinedOutput(); err != nil {
		t.Fatalf("git worktree add: %v (%s)", err, out)
	}

	// Put a committed child repo inside the worktree dir.
	gitRepoWithCommit(t, filepath.Join(wtDir, "child"))

	_, err := m.Add(ctx, project.AddInput{Path: wtDir, ProjectID: ptr("wt"), AsWorkspace: true})
	wantCode(t, err, "WORKSPACE_PARENT_IS_WORKTREE")
}

// TestManager_AddWorkspaceAdoptsSeparateGitDirParent verifies that a parent repo
// created with `git init --separate-git-dir=<elsewhere>` (whose .git is a file,
// not a dir) is correctly identified as a standalone repo and NOT rejected as a
// linked worktree. Add with AsWorkspace must succeed and register the child.
func TestManager_AddWorkspaceAdoptsSeparateGitDirParent(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	base := t.TempDir()
	parent := filepath.Join(base, "parent")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		t.Fatalf("mkdir parent: %v", err)
	}
	// The git directory lives outside the parent tree — this is the
	// separate-git-dir scenario. .git inside parent will be a file.
	separateGitDir := filepath.Join(base, "parent.git")
	if out, err := exec.Command("git", "init", "--separate-git-dir="+separateGitDir, "-b", "main", parent).CombinedOutput(); err != nil {
		t.Fatalf("git init --separate-git-dir: %v (%s)", err, out)
	}
	// Commit a file in the parent so the parent is a valid (non-bare) repo.
	if err := os.WriteFile(filepath.Join(parent, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	if out, err := exec.Command("git", "-C", parent, "add", "README.md").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v (%s)", err, out)
	}
	if out, err := exec.Command("git", "-C", parent, "commit", "-m", "initial").CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v (%s)", err, out)
	}

	// Put a committed child repo inside the parent.
	gitRepoWithCommit(t, filepath.Join(parent, "svc"))

	proj, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("sgd"), AsWorkspace: true})
	if err != nil {
		t.Fatalf("Add workspace with separate-git-dir parent: %v", err)
	}
	if proj.Kind != domain.ProjectKindWorkspace {
		t.Fatalf("Kind = %q, want workspace", proj.Kind)
	}
	if len(proj.WorkspaceRepos) != 1 || proj.WorkspaceRepos[0].Name != "svc" {
		t.Fatalf("WorkspaceRepos = %#v, want [{svc}]", proj.WorkspaceRepos)
	}
}

// TestManager_AddWorkspaceRejectsWorktreeChild verifies that a child whose .git
// is a file (linked worktree) is rejected.
func TestManager_AddWorkspaceRejectsWorktreeChild(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	base := t.TempDir()
	parent := filepath.Join(base, "parent")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		t.Fatalf("mkdir parent: %v", err)
	}
	// An external standalone repo used as the source for a worktree child.
	extRepo := filepath.Join(base, "ext")
	gitRepoWithCommit(t, extRepo)

	// child is a linked worktree of extRepo, placed inside parent.
	child := filepath.Join(parent, "child")
	if out, err := exec.Command("git", "-C", extRepo, "worktree", "add", child).CombinedOutput(); err != nil {
		t.Fatalf("git worktree add child: %v (%s)", err, out)
	}

	_, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("wc"), AsWorkspace: true})
	wantCode(t, err, "WORKSPACE_CHILD_IS_WORKTREE")
}

// TestManager_AddWorkspaceRejectsReservedChildName verifies that a child repo
// named __root__ is rejected to avoid a PK collision in session_worktrees.
func TestManager_AddWorkspaceRejectsReservedChildName(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	parent := t.TempDir()
	gitRepoWithCommit(t, filepath.Join(parent, domain.RootWorkspaceRepoName))

	_, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("res"), AsWorkspace: true})
	wantCode(t, err, "WORKSPACE_CHILD_RESERVED_NAME")
}

// TestManager_AddWorkspaceInitRollsBackOnNestedGitlink verifies that when a
// nested git repo at depth ≥2 causes guardNoGitlinks to fail, initWorkspaceParent
// rolls back the .git dir and .gitignore so the folder is exactly as it was.
// A retry of the same Add must fail with the same error, not a stranded-state error.
func TestManager_AddWorkspaceInitRollsBackOnNestedGitlink(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	parent := t.TempDir()
	// One direct committed child repo — valid on its own.
	gitRepoWithCommit(t, filepath.Join(parent, "app"))
	// A nested git repo at packages/foo — depth 2 relative to parent.
	// detectWorkspaceChildren never registers it (packages/ itself is not a repo),
	// but git add -A would stage it as a gitlink.
	pkgs := filepath.Join(parent, "packages")
	if err := os.MkdirAll(pkgs, 0o755); err != nil {
		t.Fatalf("mkdir packages: %v", err)
	}
	gitRepoWithCommit(t, filepath.Join(pkgs, "foo"))

	_, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("rbt"), AsWorkspace: true})
	wantCode(t, err, "WORKSPACE_PARENT_GITLINK")

	// Rollback: .git must not exist.
	if _, statErr := os.Lstat(filepath.Join(parent, ".git")); statErr == nil {
		t.Fatal(".git still exists after rollback")
	}
	// Rollback: .gitignore must not exist (it didn't exist before the call).
	if _, statErr := os.Lstat(filepath.Join(parent, ".gitignore")); statErr == nil {
		t.Fatal(".gitignore still exists after rollback")
	}

	// Retry must fail with the same error, not a different stranded-state error.
	_, err2 := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("rbt"), AsWorkspace: true})
	wantCode(t, err2, "WORKSPACE_PARENT_GITLINK")
}

// TestManager_AddWorkspaceConcurrentSamePath verifies that two goroutines racing
// on the same parent path result in exactly one success and one PATH_ALREADY_REGISTERED
// error. The -race detector will catch any unsynchronised access.
func TestManager_AddWorkspaceConcurrentSamePath(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	parent := t.TempDir()
	gitRepoWithCommit(t, filepath.Join(parent, "svc"))

	type result struct {
		proj project.Project
		err  error
	}
	results := make([]result, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	for i := range results {
		go func() {
			defer wg.Done()
			p, err := m.Add(ctx, project.AddInput{Path: parent, ProjectID: ptr("con"), AsWorkspace: true})
			results[i] = result{p, err}
		}()
	}
	wg.Wait()

	successes, failures := 0, 0
	for _, r := range results {
		if r.err == nil {
			successes++
		} else {
			failures++
			wantCode(t, r.err, "PATH_ALREADY_REGISTERED")
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("expected 1 success and 1 PATH_ALREADY_REGISTERED; got successes=%d failures=%d (errors: %v %v)",
			successes, failures, results[0].err, results[1].err)
	}
}

// TestManager_AddWorkspaceRejectsBareParent verifies that a bare git repository
// is rejected as a workspace parent before any mutation occurs.
func TestManager_AddWorkspaceRejectsBareParent(t *testing.T) {
	configureCommitter(t)
	ctx := context.Background()
	m := newManager(t)

	base := t.TempDir()
	bareParent := filepath.Join(base, "bare.git")
	if out, err := exec.Command("git", "init", "--bare", bareParent).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v (%s)", err, out)
	}

	// Place a committed child repo inside the bare parent directory.
	gitRepoWithCommit(t, filepath.Join(bareParent, "child"))

	_, err := m.Add(ctx, project.AddInput{Path: bareParent, ProjectID: ptr("bare"), AsWorkspace: true})
	wantCode(t, err, "WORKSPACE_PARENT_BARE")
}
