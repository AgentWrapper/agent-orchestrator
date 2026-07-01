package gitworktree

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestCommandArgs(t *testing.T) {
	repo := "/repo"
	path := "/managed/proj/sess"
	branch := "feature/test"

	cases := []struct {
		name string
		got  []string
		want []string
	}{
		{"check ref", checkRefFormatBranchArgs(repo, branch), []string{"-C", repo, "check-ref-format", "--branch", branch}},
		{"rev parse", revParseVerifyArgs(repo, "origin/main"), []string{"-C", repo, "rev-parse", "--verify", "--quiet", "origin/main"}},
		{"add existing", worktreeAddBranchArgs(repo, path, branch), []string{"-C", repo, "worktree", "add", path, branch}},
		{"add new", worktreeAddNewBranchArgs(repo, branch, path, "origin/main"), []string{"-C", repo, "worktree", "add", "-b", branch, path, "origin/main"}},
		// No --force: a dirty worktree must cause `git worktree remove` to fail so
		// the post-prune safety check surfaces the refusal instead of deleting
		// uncommitted agent work (review item RA).
		{"remove", worktreeRemoveArgs(repo, path), []string{"-C", repo, "worktree", "remove", path}},
		{"prune", worktreePruneArgs(repo), []string{"-C", repo, "worktree", "prune"}},
		{"list", worktreeListPorcelainArgs(repo), []string{"-C", repo, "worktree", "list", "--porcelain"}},
		{"status", statusPorcelainArgs(path), []string{"-C", path, "status", "--porcelain"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !reflect.DeepEqual(tc.got, tc.want) {
				t.Fatalf("args = %#v, want %#v", tc.got, tc.want)
			}
		})
	}
}

func TestBaseRefCandidates(t *testing.T) {
	got := baseRefCandidates("feature/test", "main")
	want := []string{"origin/feature/test", "origin/main", "refs/heads/main", "feature/test"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates = %#v, want %#v", got, want)
	}

	got = baseRefCandidates("feature/test", "upstream/main")
	want = []string{"origin/feature/test", "upstream/main", "feature/test"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("qualified candidates = %#v, want %#v", got, want)
	}
}

func TestParseWorktreePorcelain(t *testing.T) {
	input := strings.Join([]string{
		"worktree /repo",
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		"worktree /managed/proj/sess1",
		"HEAD def456",
		"branch refs/heads/feature/test",
		"",
		"worktree /managed/proj/sess2",
		"HEAD 789abc",
		"detached",
		"",
		"worktree /bare",
		"bare",
		"",
	}, "\n")

	recs, err := parseWorktreePorcelain(input)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(recs) != 4 {
		t.Fatalf("len = %d, want 4: %#v", len(recs), recs)
	}
	if recs[1].Path != "/managed/proj/sess1" || recs[1].Branch != "feature/test" {
		t.Fatalf("normal record = %#v", recs[1])
	}
	if !recs[2].Detached || recs[2].Branch != "" {
		t.Fatalf("detached record = %#v", recs[2])
	}
	if !recs[3].Bare {
		t.Fatalf("bare record = %#v", recs[3])
	}
}

func TestManagedPathSafety(t *testing.T) {
	root := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": root}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	path, err := ws.managedPath(ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess"})
	if err != nil {
		t.Fatalf("managed path: %v", err)
	}
	if want := filepath.Join(ws.managedRoot, "proj", "sess"); path != want {
		t.Fatalf("path = %q, want %q", path, want)
	}
	if _, err := ws.validateManagedPath(filepath.Join(root, "..", "outside")); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("outside error = %v, want ErrUnsafePath", err)
	}
	if _, err := ws.validateManagedPath("relative/path"); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("relative error = %v, want ErrUnsafePath", err)
	}
}

func TestOrchestratorManagedPath(t *testing.T) {
	root := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": root}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	t.Run("explicit prefix", func(t *testing.T) {
		cfg := ports.WorkspaceConfig{
			ProjectID:     "proj",
			SessionID:     "proj-1",
			Kind:          domain.KindOrchestrator,
			SessionPrefix: "ao-agents",
		}
		path, err := ws.managedPath(cfg)
		if err != nil {
			t.Fatalf("managed path: %v", err)
		}
		want := filepath.Join(ws.managedRoot, "proj", "orchestrator", "ao-agents-orchestrator")
		if path != want {
			t.Fatalf("path = %q, want %q", path, want)
		}
	})

	t.Run("prefix derived from project id", func(t *testing.T) {
		cfg := ports.WorkspaceConfig{
			ProjectID: "longprojectid123",
			SessionID: "longprojectid123-1",
			Kind:      domain.KindOrchestrator,
		}
		path, err := ws.managedPath(cfg)
		if err != nil {
			t.Fatalf("managed path: %v", err)
		}
		want := filepath.Join(ws.managedRoot, "longprojectid123", "orchestrator", "longprojecti-orchestrator")
		if path != want {
			t.Fatalf("path = %q, want %q", path, want)
		}
	})

	t.Run("short project id used as prefix", func(t *testing.T) {
		cfg := ports.WorkspaceConfig{
			ProjectID: "proj",
			SessionID: "proj-1",
			Kind:      domain.KindOrchestrator,
		}
		path, err := ws.managedPath(cfg)
		if err != nil {
			t.Fatalf("managed path: %v", err)
		}
		want := filepath.Join(ws.managedRoot, "proj", "orchestrator", "proj-orchestrator")
		if path != want {
			t.Fatalf("path = %q, want %q", path, want)
		}
	})
}

func TestCreateReusesRegisteredWorktreeAtExpectedPath(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	path := filepath.Join(ws.managedRoot, "proj", "orchestrator", "proj-orchestrator")
	cfg := ports.WorkspaceConfig{
		ProjectID:     "proj",
		SessionID:     "proj-1",
		Kind:          domain.KindOrchestrator,
		SessionPrefix: "proj",
		Branch:        "ao/proj-orchestrator",
	}
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "check-ref-format"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + path + "\nbranch refs/heads/ao/proj-orchestrator\n"), nil
		default:
			t.Fatalf("unexpected git invocation: %v", args)
			return nil, nil
		}
	}

	info, err := ws.Create(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if info.Path != path || info.Branch != "ao/proj-orchestrator" {
		t.Fatalf("info = %#v, want path %q branch ao/proj-orchestrator", info, path)
	}
}

// TestValidateConfigRejectsPathEscapingIDs covers review item RB: filepath.Join
// in managedPath cleans `..` segments before validateManagedPath sees them, so a
// session id of "../other" would stay inside managedRoot while jumping projects.
// validateConfig must reject these at the source — before any path is composed.
func TestValidateConfigRejectsPathEscapingIDs(t *testing.T) {
	root := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": root}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	cases := []struct {
		name string
		cfg  ports.WorkspaceConfig
	}{
		{"session contains slash escapes project root", ports.WorkspaceConfig{ProjectID: "proj", SessionID: "../other", Branch: "main"}},
		{"session is .. is rejected", ports.WorkspaceConfig{ProjectID: "proj", SessionID: "..", Branch: "main"}},
		{"session is . is rejected", ports.WorkspaceConfig{ProjectID: "proj", SessionID: ".", Branch: "main"}},
		{"session contains backslash is rejected", ports.WorkspaceConfig{ProjectID: "proj", SessionID: `evil\sess`, Branch: "main"}},
		{"project contains slash escapes managed root", ports.WorkspaceConfig{ProjectID: "../proj", SessionID: "sess", Branch: "main"}},
		{"project is .. is rejected", ports.WorkspaceConfig{ProjectID: "..", SessionID: "sess", Branch: "main"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Create rejects it directly through validateConfig.
			if _, err := ws.Create(context.Background(), tc.cfg); !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("Create err = %v, want ErrUnsafePath", err)
			}
			// Restore also goes through validateConfig, so the same guarantee holds.
			if _, err := ws.Restore(context.Background(), tc.cfg); !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("Restore err = %v, want ErrUnsafePath", err)
			}
		})
	}
}

// TestValidateConfigAcceptsBenignIDs is a positive guard so the rejection rule
// above does not creep into normal session/project naming. Hyphens, underscores,
// dots inside (e.g. "foo.bar"), and digits all stay allowed.
func TestValidateConfigAcceptsBenignIDs(t *testing.T) {
	cases := []ports.WorkspaceConfig{
		{ProjectID: "proj-1", SessionID: "sess_2", Branch: "main"},
		{ProjectID: "foo.bar", SessionID: "abc-42", Branch: "main"},
		{ProjectID: "p", SessionID: "..hidden", Branch: "main"}, // leading dots != ".."
	}
	for i, cfg := range cases {
		if err := validateConfig(cfg); err != nil {
			t.Errorf("case %d %+v: unexpected error: %v", i, cfg, err)
		}
	}
}

func TestRestoreRefusesNonEmptyUnregisteredPath(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ws.run = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("worktree " + repo + "\nbranch refs/heads/main\n"), nil
	}
	path := filepath.Join(ws.managedRoot, "proj", "sess")
	if err := mkdirFile(path, "keep.txt"); err != nil {
		t.Fatalf("seed path: %v", err)
	}
	_, err = ws.Restore(context.Background(), ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/one"})
	if err == nil || !strings.Contains(err.Error(), "path exists and is not a registered worktree") {
		t.Fatalf("restore error = %v", err)
	}
}

func TestRestoreWithRepoPathMovesStrayPathAside(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	path := filepath.Join(ws.managedRoot, "proj", "sess", "api")
	if err := mkdirFile(path, "keep.txt"); err != nil {
		t.Fatalf("seed path: %v", err)
	}
	var addPath string
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + repo + "\nbranch refs/heads/main\n"), nil
		case strings.Contains(joined, "check-ref-format"):
			return nil, nil
		case strings.Contains(joined, "rev-parse"):
			return []byte("commit"), nil
		case strings.Contains(joined, "worktree add"):
			if len(args) >= 2 {
				addPath = args[len(args)-2]
			}
			if addPath == "" {
				t.Fatalf("could not find worktree add path in args: %v", args)
			}
			return nil, nil
		default:
			t.Fatalf("unexpected git invocation: %v", args)
			return nil, nil
		}
	}

	info, err := ws.Restore(context.Background(), ports.WorkspaceConfig{
		ProjectID: "proj",
		SessionID: "proj-1",
		Branch:    "ao/proj-1",
		RepoPath:  repo,
		Path:      path,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if info.Path != path || addPath != path {
		t.Fatalf("restored path=%q addPath=%q, want %q", info.Path, addPath, path)
	}
	if _, err := os.Stat(filepath.Join(path+".stray", "keep.txt")); err != nil {
		t.Fatalf("stray path was not preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(path, "keep.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("original path still has stray file: %v", err)
	}
}

func TestDestroyRefusesStillRegisteredPathAndPreservesDirectory(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	path := filepath.Join(ws.managedRoot, "proj", "sess")
	if err := mkdirFile(path, "keep.txt"); err != nil {
		t.Fatalf("seed path: %v", err)
	}
	var removeArgs []string
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "worktree remove"):
			removeArgs = append([]string{}, args...)
			return []byte("locked"), errors.New("remove failed")
		case strings.Contains(joined, "worktree prune"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + path + "\nbranch refs/heads/feature/one\n"), nil
		default:
			return nil, nil
		}
	}
	err = ws.Destroy(context.Background(), ports.WorkspaceInfo{Path: path, ProjectID: "proj", SessionID: "sess", Branch: "feature/one"})
	if err == nil || !strings.Contains(err.Error(), "still registered") {
		t.Fatalf("destroy error = %v", err)
	}
	// The stub reports a clean `git status`, so the refusal must NOT be typed as
	// a dirty workspace — Kill/Cleanup would otherwise silently skip a refusal
	// that has a different cause (e.g. a locked worktree).
	if errors.Is(err, ports.ErrWorkspaceDirty) {
		t.Fatalf("destroy error = %v, want non-dirty refusal for clean status", err)
	}
	if _, statErr := os.Stat(filepath.Join(path, "keep.txt")); statErr != nil {
		t.Fatalf("expected directory to be preserved: %v", statErr)
	}
	// Belt-and-braces: --force must NEVER be passed to `git worktree remove` from
	// Destroy. If it ever is, dirty worktrees would be deleted instead of routed
	// to Skipped by the Session Manager's Cleanup (review item RA).
	for _, a := range removeArgs {
		if a == "--force" || a == "-f" {
			t.Fatalf("git worktree remove was called with %q; --force must never be passed", a)
		}
	}
}

// TestDestroyClassifiesDirtyWorktree covers the typed dirty refusal: when
// `git worktree remove` fails, the path stays registered, and `git status`
// reports uncommitted work, Destroy must wrap ports.ErrWorkspaceDirty so the
// Session Manager can preserve the workspace (Kill freed=false, Cleanup
// skipped-with-reason) instead of surfacing an opaque 500.
func TestDestroyClassifiesDirtyWorktree(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	path := filepath.Join(ws.managedRoot, "proj", "sess")
	if err := mkdirFile(path, "keep.txt"); err != nil {
		t.Fatalf("seed path: %v", err)
	}
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "worktree remove"):
			return []byte("contains modified or untracked files"), errors.New("remove failed")
		case strings.Contains(joined, "worktree prune"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + path + "\nbranch refs/heads/feature/one\n"), nil
		case strings.Contains(joined, "status --porcelain"):
			return []byte("?? keep.txt\n"), nil
		default:
			return nil, nil
		}
	}
	err = ws.Destroy(context.Background(), ports.WorkspaceInfo{Path: path, ProjectID: "proj", SessionID: "sess", Branch: "feature/one"})
	if !errors.Is(err, ports.ErrWorkspaceDirty) {
		t.Fatalf("destroy error = %v, want ports.ErrWorkspaceDirty", err)
	}
	if _, statErr := os.Stat(filepath.Join(path, "keep.txt")); statErr != nil {
		t.Fatalf("expected dirty worktree to be preserved: %v", statErr)
	}
}

// TestAddWorktreeRefusesBranchCheckedOutElsewhere covers Bug 3 (a): if the
// requested branch is already checked out in another worktree of the same repo,
// Create must surface ports.ErrWorkspaceBranchCheckedOutElsewhere so the HTTP
// layer can render a typed 409 instead of leaking raw git stderr through a 500.
func TestAddWorktreeRefusesBranchCheckedOutElsewhere(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	otherPath := filepath.Join(root, "proj", "other")
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "check-ref-format"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + otherPath + "\nbranch refs/heads/feature/x\n"), nil
		case strings.Contains(joined, "rev-parse"):
			return []byte("commit"), nil
		default:
			t.Fatalf("unexpected git invocation: %v", args)
			return nil, nil
		}
	}
	_, err = ws.Create(context.Background(), ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/x"})
	if !errors.Is(err, ports.ErrWorkspaceBranchCheckedOutElsewhere) {
		t.Fatalf("err = %v, want ports.ErrWorkspaceBranchCheckedOutElsewhere", err)
	}
	if !strings.Contains(err.Error(), otherPath) {
		t.Fatalf("err = %v, want message to include conflicting path %q", err, otherPath)
	}
}

// TestCreateRejectsInvalidBranchName covers the residual of #152 Bug 3: a branch
// name rejected by `git check-ref-format` must surface
// ports.ErrWorkspaceBranchInvalid so the HTTP layer renders a typed 400 instead
// of leaking raw git stderr through a 500.
func TestCreateRejectsInvalidBranchName(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "check-ref-format") {
			return nil, errors.New("fatal: 'bad branch!!' is not a valid branch name")
		}
		t.Fatalf("no git beyond check-ref-format should run for an invalid branch: %v", args)
		return nil, nil
	}
	_, err = ws.Create(context.Background(), ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "bad branch!!"})
	if !errors.Is(err, ports.ErrWorkspaceBranchInvalid) {
		t.Fatalf("err = %v, want ports.ErrWorkspaceBranchInvalid", err)
	}
	if !strings.Contains(err.Error(), "bad branch!!") {
		t.Fatalf("err = %v, want message to include the rejected branch name", err)
	}
}

// TestAddWorktreeReportsBranchNotFetched covers Bug 3 (b): if no local head,
// no origin remote-tracking branch, no default branch ref, and no tag of the
// same name is reachable, Create must surface ports.ErrWorkspaceBranchNotFetched
// so the HTTP layer can render a typed 400 with a `git fetch` suggestion.
func TestAddWorktreeReportsBranchNotFetched(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	ws, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	// Build a real exit-1 error so refExists treats every probe as "absent".
	exitOne := func() error {
		cmd := exec.Command("sh", "-c", "exit 1")
		return cmd.Run()
	}()
	ws.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "check-ref-format"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return nil, nil
		case strings.Contains(joined, "rev-parse"):
			return nil, commandError{args: args, err: exitOne}
		default:
			t.Fatalf("unexpected git invocation: %v", args)
			return nil, nil
		}
	}
	_, err = ws.Create(context.Background(), ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: "feature/missing"})
	if !errors.Is(err, ports.ErrWorkspaceBranchNotFetched) {
		t.Fatalf("err = %v, want ports.ErrWorkspaceBranchNotFetched", err)
	}
}

func mkdirFile(dir, name string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), []byte("data"), 0o644)
}
