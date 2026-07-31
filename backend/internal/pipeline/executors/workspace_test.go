package executors

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// fakeTrees stands in for the gitworktree adapter: it records what would have
// been created or destroyed without touching git or the filesystem.
type fakeTrees struct {
	mu        sync.Mutex
	restores  []ports.WorkspaceConfig
	destroyed []ports.WorkspaceInfo
	err       error
}

func (f *fakeTrees) Restore(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return ports.WorkspaceInfo{}, f.err
	}
	f.restores = append(f.restores, cfg)
	return ports.WorkspaceInfo{Path: cfg.Path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
}

func (f *fakeTrees) ForceDestroy(_ context.Context, info ports.WorkspaceInfo) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.destroyed = append(f.destroyed, info)
	return nil
}

func (f *fakeTrees) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.restores))
	for _, cfg := range f.restores {
		out = append(out, cfg.Path)
	}
	return out
}

type fakeSessions map[string]string

func (f fakeSessions) Get(_ context.Context, sessionID string) (string, bool, error) {
	path, ok := f[sessionID]
	return path, ok, nil
}

type fakeCheckouts map[string]string

func (f fakeCheckouts) CheckoutPath(projectID string) (string, error) {
	path, ok := f[projectID]
	if !ok {
		return "", errors.New("no checkout for project " + projectID)
	}
	return path, nil
}

const (
	testProject = "proj-1"
	testRunID   = pipeline.RunID("run-7")
	testRunDir  = "/data/pipelines/proj-1/run-7"
)

func newTestResolver(t *testing.T) (*WorkspaceResolver, *fakeTrees) {
	t.Helper()
	trees := &fakeTrees{}
	sessions := fakeSessions{"sess-1": "/data/worktrees/proj-1/sess-1"}
	checkouts := fakeCheckouts{testProject: "/home/dev/proj-1"}
	return NewWorkspaceResolver(trees, sessions, checkouts), trees
}

func baseRequest(kind pipeline.WorkspaceKind) WorkspaceRequest {
	return WorkspaceRequest{
		Kind:      kind,
		ProjectID: testProject,
		RunID:     testRunID,
		Subject:   pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: testProject, SessionID: "sess-1"},
		BaseRef:   "main",
		RunDir:    testRunDir,
	}
}

func TestProvisionRunWorkspaceIsMemoized(t *testing.T) {
	r, trees := newTestResolver(t)
	ctx := context.Background()

	req := baseRequest(pipeline.WorkspaceRun)
	req.StageID = "build"
	first, owned, err := r.Provision(ctx, req)
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}
	if !owned {
		t.Fatal("run workspace must be owned by the run")
	}
	want := filepath.Join(testRunDir, "workspace")
	if first != want {
		t.Fatalf("run workspace path = %q, want %q", first, want)
	}

	req.StageID = "test"
	second, owned, err := r.Provision(ctx, req)
	if err != nil {
		t.Fatalf("second provision: %v", err)
	}
	if !owned || second != first {
		t.Fatalf("second provision = (%q, %v), want the memoized (%q, true)", second, owned, first)
	}
	if got := trees.paths(); len(got) != 1 {
		t.Fatalf("worktree created %d times, want exactly once: %v", len(got), got)
	}
}

func TestProvisionRunWorkspacePassesSubjectRef(t *testing.T) {
	r, trees := newTestResolver(t)

	if _, _, err := r.Provision(context.Background(), baseRequest(pipeline.WorkspaceRun)); err != nil {
		t.Fatalf("provision: %v", err)
	}
	cfg := trees.restores[0]
	if cfg.BaseBranch != "main" {
		t.Fatalf("base branch = %q, want the subject ref %q", cfg.BaseBranch, "main")
	}
	if cfg.ProjectID != testProject {
		t.Fatalf("project id = %q, want %q", cfg.ProjectID, testProject)
	}
	if cfg.Branch == "" || !strings.Contains(cfg.Branch, string(testRunID)) {
		t.Fatalf("branch %q must be run-scoped", cfg.Branch)
	}
	if cfg.SessionID == "" {
		t.Fatal("session id must be set: the adapter requires a name for the tree")
	}
}

func TestProvisionStageWorkspacesAreDistinctPerStage(t *testing.T) {
	r, trees := newTestResolver(t)
	ctx := context.Background()

	paths := map[string]string{}
	for _, stage := range []string{"lint", "build"} {
		req := baseRequest(pipeline.WorkspaceStage)
		req.StageID = stage
		path, owned, err := r.Provision(ctx, req)
		if err != nil {
			t.Fatalf("provision %s: %v", stage, err)
		}
		if !owned {
			t.Fatalf("stage workspace for %s must be owned", stage)
		}
		paths[stage] = path
	}
	if paths["lint"] == paths["build"] {
		t.Fatalf("stage workspaces collided at %q", paths["lint"])
	}
	if want := filepath.Join(testRunDir, "workspaces", "lint"); paths["lint"] != want {
		t.Fatalf("stage workspace = %q, want %q", paths["lint"], want)
	}
	if len(trees.restores) != 2 {
		t.Fatalf("created %d worktrees, want 2", len(trees.restores))
	}
	if trees.restores[0].Branch == trees.restores[1].Branch {
		t.Fatalf("stage branches collided at %q", trees.restores[0].Branch)
	}
}

func TestProvisionStageWorkspaceIsFreshOnReentry(t *testing.T) {
	r, trees := newTestResolver(t)
	ctx := context.Background()

	req := baseRequest(pipeline.WorkspaceStage)
	req.StageID = "flaky"
	first, _, err := r.Provision(ctx, req)
	if err != nil {
		t.Fatalf("first entry: %v", err)
	}
	second, _, err := r.Provision(ctx, req)
	if err != nil {
		t.Fatalf("second entry: %v", err)
	}
	if second != first {
		t.Fatalf("second entry path = %q, want the same path %q", second, first)
	}
	if len(trees.destroyed) != 1 || trees.destroyed[0].Path != first {
		t.Fatalf("re-entry must destroy the stale tree first, got %v", trees.destroyed)
	}
	if len(trees.restores) != 2 {
		t.Fatalf("created %d worktrees, want a fresh one per entry", len(trees.restores))
	}
}

func TestProvisionInheritPassesThrough(t *testing.T) {
	r, trees := newTestResolver(t)

	req := baseRequest(pipeline.WorkspaceInherit)
	req.StageID = "diagnose"
	req.InheritPath = "/data/pipelines/proj-1/run-7/workspaces/build"
	path, owned, err := r.Provision(context.Background(), req)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if path != req.InheritPath {
		t.Fatalf("inherit path = %q, want %q", path, req.InheritPath)
	}
	if owned {
		t.Fatal("inherit must not be owned: ownership stays with the originating stage")
	}
	if len(trees.restores) != 0 {
		t.Fatalf("inherit must not create a worktree, got %v", trees.paths())
	}
}

func TestProvisionInheritWithoutPathFails(t *testing.T) {
	r, _ := newTestResolver(t)

	req := baseRequest(pipeline.WorkspaceInherit)
	req.StageID = "diagnose"
	if _, _, err := r.Provision(context.Background(), req); err == nil {
		t.Fatal("inherit with no originating tree must fail")
	}
}

func TestProvisionSessionUsesExistingWorktree(t *testing.T) {
	r, trees := newTestResolver(t)

	path, owned, err := r.Provision(context.Background(), baseRequest(pipeline.WorkspaceSession))
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if path != "/data/worktrees/proj-1/sess-1" {
		t.Fatalf("session workspace = %q", path)
	}
	if owned {
		t.Fatal("the subject's session worktree is not owned by the run")
	}
	if len(trees.restores) != 0 {
		t.Fatalf("session must reuse the existing tree, not create one: %v", trees.paths())
	}
}

func TestProvisionSessionFailsWhenSessionMissing(t *testing.T) {
	r, _ := newTestResolver(t)
	ctx := context.Background()

	gone := baseRequest(pipeline.WorkspaceSession)
	gone.Subject.SessionID = "sess-gone"
	if _, _, err := r.Provision(ctx, gone); err == nil {
		t.Fatal("a vanished session must fail the stage, never silently fall back")
	}

	none := baseRequest(pipeline.WorkspaceSession)
	none.Subject = pipeline.Subject{Kind: pipeline.SubjectPR, ProjectID: testProject}
	if _, _, err := r.Provision(ctx, none); err == nil {
		t.Fatal("a sessionless subject must fail the stage, never silently fall back")
	}
}

func TestProvisionCheckoutUsesPrimaryCheckout(t *testing.T) {
	r, trees := newTestResolver(t)

	path, owned, err := r.Provision(context.Background(), baseRequest(pipeline.WorkspaceCheckout))
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if path != "/home/dev/proj-1" {
		t.Fatalf("checkout = %q", path)
	}
	if owned {
		t.Fatal("the primary checkout is never owned by the run")
	}
	if len(trees.restores) != 0 {
		t.Fatalf("checkout must not create a worktree: %v", trees.paths())
	}
}

func TestProvisionOwnedFlagPerKind(t *testing.T) {
	cases := []struct {
		kind  pipeline.WorkspaceKind
		owned bool
	}{
		{pipeline.WorkspaceSession, false},
		{pipeline.WorkspaceRun, true},
		{pipeline.WorkspaceStage, true},
		{pipeline.WorkspaceCheckout, false},
		{pipeline.WorkspaceInherit, false},
	}
	for _, tc := range cases {
		t.Run(string(tc.kind), func(t *testing.T) {
			r, _ := newTestResolver(t)
			req := baseRequest(tc.kind)
			req.StageID = "build"
			req.InheritPath = "/data/pipelines/proj-1/run-7/workspaces/prev"
			_, owned, err := r.Provision(context.Background(), req)
			if err != nil {
				t.Fatalf("provision: %v", err)
			}
			if owned != tc.owned {
				t.Fatalf("owned = %v, want %v", owned, tc.owned)
			}
		})
	}
}

func TestProvisionRejectsUnresolvedKinds(t *testing.T) {
	r, _ := newTestResolver(t)
	for _, kind := range []pipeline.WorkspaceKind{pipeline.WorkspaceAuto, pipeline.WorkspaceUnset, "bogus"} {
		req := baseRequest(kind)
		req.StageID = "build"
		if _, _, err := r.Provision(context.Background(), req); err == nil {
			t.Fatalf("kind %q must be rejected: ComputePlan resolves it before the run starts", kind)
		}
	}
}

func TestProvisionRejectsUnsafeIDs(t *testing.T) {
	r, _ := newTestResolver(t)
	ctx := context.Background()

	traversal := baseRequest(pipeline.WorkspaceStage)
	traversal.StageID = "../escape"
	if _, _, err := r.Provision(ctx, traversal); err == nil {
		t.Fatal("a stage id with a path separator must be rejected")
	}

	empty := baseRequest(pipeline.WorkspaceStage)
	if _, _, err := r.Provision(ctx, empty); err == nil {
		t.Fatal("an empty stage id must be rejected")
	}

	badRun := baseRequest(pipeline.WorkspaceRun)
	badRun.RunID = "../escape"
	if _, _, err := r.Provision(ctx, badRun); err == nil {
		t.Fatal("a run id with a path separator must be rejected")
	}
}

func TestDestroyRemovesOwnedTreeAndForgetsIt(t *testing.T) {
	r, trees := newTestResolver(t)
	ctx := context.Background()

	path, _, err := r.Provision(ctx, baseRequest(pipeline.WorkspaceRun))
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if err := r.Destroy(ctx, path); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	if len(trees.destroyed) != 1 || trees.destroyed[0].Path != path {
		t.Fatalf("destroyed = %v, want one entry for %q", trees.destroyed, path)
	}
	if _, _, err := r.Provision(ctx, baseRequest(pipeline.WorkspaceRun)); err != nil {
		t.Fatalf("re-provision: %v", err)
	}
	if len(trees.restores) != 2 {
		t.Fatalf("a destroyed run workspace must be re-created, restores = %d", len(trees.restores))
	}
}

func TestDestroyRefusesUnknownPath(t *testing.T) {
	r, trees := newTestResolver(t)

	if err := r.Destroy(context.Background(), "/etc"); err == nil {
		t.Fatal("destroying a path this resolver never provisioned must fail")
	}
	if len(trees.destroyed) != 0 {
		t.Fatalf("nothing must be destroyed, got %v", trees.destroyed)
	}
}

func TestProvisionSurfacesAdapterErrors(t *testing.T) {
	trees := &fakeTrees{err: errors.New("worktree add failed")}
	r := NewWorkspaceResolver(trees, fakeSessions{}, fakeCheckouts{testProject: "/home/dev/proj-1"})

	_, _, err := r.Provision(context.Background(), baseRequest(pipeline.WorkspaceRun))
	if err == nil || !strings.Contains(err.Error(), "worktree add failed") {
		t.Fatalf("err = %v, want the adapter failure surfaced", err)
	}
	if _, ok := r.runs[testRunID]; ok {
		t.Fatal("a failed provision must not be memoized")
	}
}

var _ WorkspaceProvisioner = (*WorkspaceResolver)(nil)

// The shipped adapter satisfies the seam as-is: pipelines create trees through
// the same checkout-not-clone path sessions use, with no new adapter and no
// glue type. Kept in the test file so the production code stays free of the
// concrete dependency.
var _ Worktrees = (*gitworktree.Workspace)(nil)
