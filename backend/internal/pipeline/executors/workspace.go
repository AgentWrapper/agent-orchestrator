package executors

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// WorkspaceProvisioner hands a stage the tree it runs in. The engine calls it
// lazily, when a StartStage effect executes, so a branch that is never taken
// never pays for a checkout (decision D8).
//
// owned reports whether the run created the tree and may therefore destroy it.
// The teardown policy itself lives with the driver: owned trees are destroyed
// when the run settles succeeded and kept otherwise (spec section 5.5).
type WorkspaceProvisioner interface {
	Provision(ctx context.Context, req WorkspaceRequest) (path string, owned bool, err error)
	Destroy(ctx context.Context, path string) error
}

// WorkspaceRequest is one stage's ask, already resolved by ComputePlan: Kind is
// never auto or unset by the time it reaches the provisioner.
type WorkspaceRequest struct {
	Kind        pipeline.WorkspaceKind // resolved: session|run|stage|checkout|inherit
	ProjectID   string
	RunID       pipeline.RunID
	StageID     string
	Subject     pipeline.Subject
	InheritPath string // failed stage's tree for inherit
	BaseRef     string // subject's ref for run/stage worktrees
	RunDir      string
}

// Worktrees is the slice of the gitworktree adapter this resolver needs.
// *gitworktree.Workspace satisfies it as-is, so pipelines create trees through
// the same checkout-not-clone path sessions use.
//
// The injected adapter must be rooted at the pipelines base dir
// (<AO_DATA_DIR>/pipelines), because run and stage trees live inside the run
// folder and the adapter refuses any path outside its managed root.
type Worktrees interface {
	Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error)
	ForceDestroy(ctx context.Context, info ports.WorkspaceInfo) error
}

// SessionWorkspaces resolves the subject session's existing worktree.
type SessionWorkspaces interface {
	Get(ctx context.Context, sessionID string) (path string, ok bool, err error)
}

// Checkouts resolves a project's primary local checkout, the tree the user is
// actually coding in.
type Checkouts interface {
	CheckoutPath(projectID string) (string, error)
}

// WorkspaceResolver implements WorkspaceProvisioner over the gitworktree
// adapter. One instance serves every run of a project, so the memo tables are
// keyed by run and guarded by a mutex: fan-out stages provision concurrently.
type WorkspaceResolver struct {
	trees     Worktrees
	sessions  SessionWorkspaces
	checkouts Checkouts

	mu sync.Mutex
	// runs memoizes the one tree a `workspace: run` run gets, so every later
	// stage shares the earlier stages' filesystem state (spec section 5.2).
	runs map[pipeline.RunID]string
	// entered records stage trees handed out already, so re-entering a stage
	// destroys the stale tree rather than reusing it.
	entered map[string]bool
	// owned maps a provisioned path to the handle needed to destroy it. It is
	// also the guard on Destroy: a path this resolver did not create is never
	// removed.
	owned map[string]ports.WorkspaceInfo
}

// NewWorkspaceResolver builds the resolver over its three seams.
func NewWorkspaceResolver(trees Worktrees, sessions SessionWorkspaces, checkouts Checkouts) *WorkspaceResolver {
	return &WorkspaceResolver{
		trees:     trees,
		sessions:  sessions,
		checkouts: checkouts,
		runs:      map[pipeline.RunID]string{},
		entered:   map[string]bool{},
		owned:     map[string]ports.WorkspaceInfo{},
	}
}

var _ WorkspaceProvisioner = (*WorkspaceResolver)(nil)

// Provision resolves the request to a path on disk, creating a worktree when
// the kind calls for one.
func (r *WorkspaceResolver) Provision(ctx context.Context, req WorkspaceRequest) (string, bool, error) {
	switch req.Kind {
	case pipeline.WorkspaceSession:
		path, err := r.sessionPath(ctx, req)
		return path, false, err
	case pipeline.WorkspaceCheckout:
		path, err := r.checkouts.CheckoutPath(req.ProjectID)
		if err != nil {
			return "", false, fmt.Errorf("resolve checkout for project %q: %w", req.ProjectID, err)
		}
		return path, false, nil
	case pipeline.WorkspaceInherit:
		// Ownership stays with the stage that created the tree, so an inheriting
		// stage never destroys what it was handed (spec section 5.4).
		if req.InheritPath == "" {
			return "", false, fmt.Errorf("stage %q requires workspace 'inherit' but no stage routed a tree into it", req.StageID)
		}
		return req.InheritPath, false, nil
	case pipeline.WorkspaceRun:
		path, err := r.runWorkspace(ctx, req)
		return path, true, err
	case pipeline.WorkspaceStage:
		path, err := r.stageWorkspace(ctx, req)
		return path, true, err
	default:
		// auto and unset are resolved by ComputePlan before the first stage
		// starts; anything else never passed validation.
		return "", false, fmt.Errorf("stage %q has unresolved workspace kind %q", req.StageID, req.Kind)
	}
}

// sessionPath returns the subject session's own worktree. This is belt to the
// plan-time check in ComputePlan: the session can still vanish between plan and
// start, and then the stage fails with the reason stated rather than silently
// running somewhere else (spec section 5.3).
func (r *WorkspaceResolver) sessionPath(ctx context.Context, req WorkspaceRequest) (string, error) {
	sessionID := req.Subject.SessionID
	if sessionID == "" {
		return "", fmt.Errorf("stage %q requires workspace 'session'; the subject has no local session", req.StageID)
	}
	path, ok, err := r.sessions.Get(ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("resolve session %q for stage %q: %w", sessionID, req.StageID, err)
	}
	if !ok || path == "" {
		return "", fmt.Errorf("stage %q requires workspace 'session'; session %q has no workspace", req.StageID, sessionID)
	}
	return path, nil
}

// runWorkspace creates <run>/workspace on first use and returns the same path
// for every later stage of the run.
func (r *WorkspaceResolver) runWorkspace(ctx context.Context, req WorkspaceRequest) (string, error) {
	if err := pathComponent("run id", string(req.RunID)); err != nil {
		return "", err
	}
	r.mu.Lock()
	memo, ok := r.runs[req.RunID]
	r.mu.Unlock()
	if ok {
		return memo, nil
	}

	target := pipeline.RunWorkspaceDir(pipeline.RunFolder{Dir: req.RunDir})
	path, err := r.create(ctx, req, target, r.branch(req.RunID, "run"), "pipeline-"+string(req.RunID))
	if err != nil {
		return "", err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	// Two stages can race to first use; the adapter is idempotent for the same
	// path, so the loser simply adopts the winner's path.
	if memo, ok := r.runs[req.RunID]; ok {
		return memo, nil
	}
	r.runs[req.RunID] = path
	return path, nil
}

// stageWorkspace creates <run>/workspaces/<stageID>, fresh each time the stage
// is entered. Concurrent stages get one tree each, which is the whole reason
// the kind exists (spec section 5.2).
func (r *WorkspaceResolver) stageWorkspace(ctx context.Context, req WorkspaceRequest) (string, error) {
	if err := pathComponent("run id", string(req.RunID)); err != nil {
		return "", err
	}
	// Stage ids are author-written and only checked for uniqueness at edit
	// time, so this is the first place that keeps one from escaping the run
	// folder.
	if err := pathComponent("stage id", req.StageID); err != nil {
		return "", err
	}

	target := pipeline.StageWorkspaceDir(pipeline.RunFolder{Dir: req.RunDir}, req.StageID)
	key := string(req.RunID) + "/" + req.StageID

	r.mu.Lock()
	stale := r.entered[key]
	info, live := r.owned[target]
	r.mu.Unlock()
	if stale && live {
		if err := r.trees.ForceDestroy(ctx, info); err != nil {
			return "", fmt.Errorf("discard stale workspace for stage %q: %w", req.StageID, err)
		}
		r.forget(target)
	}

	path, err := r.create(ctx, req, target, r.branch(req.RunID, "stage-"+req.StageID), "pipeline-"+string(req.RunID)+"-"+req.StageID)
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entered[key] = true
	return path, nil
}

// create materialises one worktree at an explicit path inside the run folder.
//
// name is the adapter's id for the tree: it names the directory for session
// worktrees, but here the path is supplied outright, so it only has to be a
// safe, recognisable label.
func (r *WorkspaceResolver) create(ctx context.Context, req WorkspaceRequest, target, branch, name string) (string, error) {
	info, err := r.trees.Restore(ctx, ports.WorkspaceConfig{
		ProjectID: domain.ProjectID(req.ProjectID),
		SessionID: domain.SessionID(name),
		Kind:      domain.KindWorker,
		Branch:    branch,
		// The subject's ref is where the tree starts. An empty BaseRef lets the
		// adapter fall back to the repo's default branch.
		BaseBranch: req.BaseRef,
		Path:       target,
	})
	if err != nil {
		return "", fmt.Errorf("create workspace for stage %q at %s: %w", req.StageID, target, err)
	}
	path := info.Path
	if path == "" {
		path = target
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.owned[path] = info
	return path, nil
}

// branch names the tree's branch. Both scopes live under one per-run directory
// so a run branch and a stage branch of the same run cannot collide in git's
// ref namespace.
func (r *WorkspaceResolver) branch(runID pipeline.RunID, scope string) string {
	return "ao/pipeline/" + string(runID) + "/" + scope
}

// Destroy removes a tree this resolver created. It refuses any other path: the
// driver's teardown must never be able to delete the user's checkout or a
// session worktree.
//
// Removal is forced. An owned pipeline tree is engine scratch, the run's
// declared artifacts already live in the run folder, and the driver only ever
// destroys after a successful run (spec section 5.5), so refusing on
// uncommitted changes would leak a tree on every run that wrote a file.
func (r *WorkspaceResolver) Destroy(ctx context.Context, path string) error {
	r.mu.Lock()
	info, ok := r.owned[path]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("destroy %q: not a workspace this run owns", path)
	}
	if err := r.trees.ForceDestroy(ctx, info); err != nil {
		return fmt.Errorf("destroy workspace %q: %w", path, err)
	}
	r.forget(path)
	return nil
}

// forget drops every memo entry pointing at a path, so the next request for it
// provisions a new tree instead of handing back a directory that is gone.
func (r *WorkspaceResolver) forget(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.owned, path)
	for runID, p := range r.runs {
		if p == path {
			delete(r.runs, runID)
		}
	}
}

// pathComponent keeps an id from escaping the run folder once joined into a
// path. Same guard rail as the run folder's own, applied to the ids that reach
// the workspace layer.
func pathComponent(what, value string) error {
	switch {
	case value == "":
		return fmt.Errorf("workspace: %s is empty", what)
	case value == "." || value == "..":
		return fmt.Errorf("workspace: %s %q is a path segment", what, value)
	case strings.ContainsAny(value, `/\`):
		return fmt.Errorf("workspace: %s %q contains a path separator", what, value)
	}
	return nil
}
