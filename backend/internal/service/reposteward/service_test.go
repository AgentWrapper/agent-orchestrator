package reposteward

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type staticToken string

func (s staticToken) Token(context.Context) (string, error) { return string(s), nil }

type fakeStore struct {
	project   domain.ProjectRecord
	sessions  []domain.SessionRecord
	worktrees map[domain.SessionID][]domain.SessionWorktreeRecord
}

func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	return f.project, id == f.project.ID, nil
}

func (f *fakeStore) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	return []domain.ProjectRecord{f.project}, nil
}

func (f *fakeStore) ListWorkspaceRepos(context.Context, string) ([]domain.WorkspaceRepoRecord, error) {
	return nil, nil
}

func (f *fakeStore) ListSessions(context.Context, domain.ProjectID) ([]domain.SessionRecord, error) {
	return f.sessions, nil
}

func (f *fakeStore) ListSessionWorktrees(_ context.Context, id domain.SessionID) ([]domain.SessionWorktreeRecord, error) {
	return f.worktrees[id], nil
}

func TestCheckpointPreservesDirtyWorkWithoutChangingIndex(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.name", "Test User")
	runGit(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "original\n")
	runGit(t, dir, "add", "tracked.txt")
	runGit(t, dir, "commit", "-m", "initial")

	writeFile(t, filepath.Join(dir, "tracked.txt"), "changed\n")
	writeFile(t, filepath.Join(dir, "untracked.txt"), "recover me\n")
	beforeStatus := runGit(t, dir, "status", "--porcelain=v1")

	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	mgr := New(Deps{
		Store: &fakeStore{project: domain.ProjectRecord{ID: "project one", Path: dir}},
		Clock: func() time.Time { return now },
	})
	status, err := mgr.Checkpoint(context.Background(), "project one")
	if err != nil {
		t.Fatalf("Checkpoint: %v", err)
	}
	if status.State != StateLocalOnly {
		t.Fatalf("state = %q, want %q; status=%+v", status.State, StateLocalOnly, status)
	}
	if len(status.Repositories) != 1 || !status.Repositories[0].Dirty {
		t.Fatalf("repositories = %+v, want one dirty checkout", status.Repositories)
	}
	if status.Repositories[0].LocalRef != "refs/ao/recovery/project-one/main" {
		t.Fatalf("local ref = %q", status.Repositories[0].LocalRef)
	}
	if got := runGit(t, dir, "status", "--porcelain=v1"); got != beforeStatus {
		t.Fatalf("real index/worktree changed:\nbefore=%q\nafter=%q", beforeStatus, got)
	}
	if got := runGit(t, dir, "show", "refs/ao/recovery/project-one/main:tracked.txt"); got != "changed" {
		t.Fatalf("tracked checkpoint = %q", got)
	}
	if got := runGit(t, dir, "show", "refs/ao/recovery/project-one/main:untracked.txt"); got != "recover me" {
		t.Fatalf("untracked checkpoint = %q", got)
	}
}

func TestTargetsIncludeAgentWorktreesAndDeduplicatePaths(t *testing.T) {
	t.Parallel()
	store := &fakeStore{
		project: domain.ProjectRecord{ID: "mer", Path: "/repo"},
		sessions: []domain.SessionRecord{{
			ID: "worker/1", ProjectID: "mer", DisplayName: "Implement recovery", Metadata: domain.SessionMetadata{WorkspacePath: "/worktrees/one"},
		}},
		worktrees: map[domain.SessionID][]domain.SessionWorktreeRecord{
			"worker/1": {
				{SessionID: "worker/1", RepoName: domain.RootWorkspaceRepoName, WorktreePath: "/worktrees/one"},
				{SessionID: "worker/1", RepoName: "api", WorktreePath: "/worktrees/one/api"},
			},
		},
	}
	mgr := New(Deps{Store: store})
	targets, err := mgr.targets(context.Background(), store.project)
	if err != nil {
		t.Fatalf("targets: %v", err)
	}
	if len(targets) != 3 {
		t.Fatalf("targets = %+v, want main + root agent + child agent", targets)
	}
	var refs []string
	for _, item := range targets {
		refs = append(refs, item.ref)
	}
	joined := strings.Join(refs, "\n")
	if !strings.Contains(joined, "refs/ao/recovery/mer/agent-worker-1") || !strings.Contains(joined, "agent-worker-1-api") {
		t.Fatalf("agent recovery refs missing: %s", joined)
	}
}

func TestRemoteClassificationAndRefSlug(t *testing.T) {
	t.Parallel()
	if !isGitHubRemote("git@github.com:owner/repo.git") || !isGitHubRemote("https://github.com/owner/repo") {
		t.Fatal("github remotes were not recognized")
	}
	if isGitHubRemote("https://gitlab.com/owner/repo") {
		t.Fatal("non-GitHub remote was recognized as GitHub")
	}
	if got := refSlug(" feature/a..b "); got != "feature-a-b" {
		t.Fatalf("refSlug = %q", got)
	}
}

func TestPushEnvironmentUsesInjectedGitHubAuthentication(t *testing.T) {
	t.Parallel()
	mgr := New(Deps{Store: &fakeStore{}, GitHubToken: staticToken("secret-token")})
	env := strings.Join(mgr.pushEnvironment(context.Background()), "\n")
	want := base64.StdEncoding.EncodeToString([]byte("x-access-token:secret-token"))
	if !strings.Contains(env, "GIT_CONFIG_VALUE_0=AUTHORIZATION: basic "+want) {
		t.Fatalf("push environment did not include GitHub auth header: %s", env)
	}
	if strings.Contains(env, "secret-token") {
		t.Fatal("raw token leaked into push environment")
	}
}

func TestConciseErrorFlattensAndLimitsHookOutput(t *testing.T) {
	t.Parallel()
	message := conciseError(errors.New(strings.Repeat("hook failed\n", 80)))
	if strings.Contains(message, "\n") || len(message) > 280 {
		t.Fatalf("concise error = %q (len %d)", message, len(message))
	}
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
