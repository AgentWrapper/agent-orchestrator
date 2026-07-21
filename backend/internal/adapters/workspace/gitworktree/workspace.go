// Package gitworktree implements ports.Workspace on top of `git worktree`:
// per-session worktrees under a managed root, typed sentinels for the failure
// modes the HTTP layer surfaces as 4xx instead of raw git stderr, a
// preserve/restore flow for uncommitted agent work (preserve.go), and
// multi-repo workspace-project sessions (project.go). Path-traversal guards
// live in paths.go; command execution and git queries in git.go.
package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultGitBinary = "git"
	// defaultBranch is the base branch used when neither the per-project config
	// nor the adapter options name one. It shares domain's single source of truth.
	defaultBranch = domain.DefaultBranchName
)

// ErrUnsafePath is returned when a resolved worktree path escapes the managed
// root (path traversal guard).
var (
	ErrUnsafePath = errors.New("gitworktree: unsafe workspace path")
)

// ErrPreservedConflict is an adapter-local alias of ports.ErrPreservedConflict.
// Tests inside this package use this name; callers outside use ports.ErrPreservedConflict
// and errors.Is works because the adapter wraps the ports sentinel.
var ErrPreservedConflict = ports.ErrPreservedConflict

// ErrBranchCheckedOutElsewhere and ErrBranchNotFetched are adapter-local aliases
// of the port-level sentinels: they preserve the gitworktree-prefixed message
// while letting the service layer match on ports.ErrWorkspaceBranchCheckedOutElsewhere
// / ports.ErrWorkspaceBranchNotFetched without importing this package. Tests
// inside the adapter use these names; callers outside use the port sentinels.
var (
	ErrBranchCheckedOutElsewhere = ports.ErrWorkspaceBranchCheckedOutElsewhere
	ErrBranchNotFetched          = ports.ErrWorkspaceBranchNotFetched
	ErrBranchInvalid             = ports.ErrWorkspaceBranchInvalid
)

// RepoResolver maps a project to the absolute path of its source git repo.
type RepoResolver interface {
	RepoPath(projectID domain.ProjectID) (string, error)
}

// StaticRepoResolver is a RepoResolver backed by a fixed project→repo-path map.
type StaticRepoResolver map[domain.ProjectID]string

// RepoPath returns the configured repo path for a project, or an error if none
// is configured.
func (r StaticRepoResolver) RepoPath(projectID domain.ProjectID) (string, error) {
	path := r[projectID]
	if path == "" {
		return "", fmt.Errorf("gitworktree: no repo configured for project %q", projectID)
	}
	return path, nil
}

// Options configures a gitworktree Workspace. ManagedRoot and RepoResolver are
// required; Binary and DefaultBranch fall back to defaults.
type Options struct {
	Binary        string
	ManagedRoot   string
	DefaultBranch string
	RepoResolver  RepoResolver
}

// Workspace creates per-session git worktrees under a managed root. It
// implements ports.Workspace.
type Workspace struct {
	binary             string
	managedRoot        string
	defaultBranch      string
	repos              RepoResolver
	run                commandRunner
	runEnv             envCommandRunner
	worktreeMetadataMu sync.Mutex
}

var _ ports.Workspace = (*Workspace)(nil)
var _ ports.WorkspaceProject = (*Workspace)(nil)

// New builds a gitworktree Workspace, validating that ManagedRoot and
// RepoResolver are set and resolving the root to an absolute, symlink-free path.
func New(opts Options) (*Workspace, error) {
	binary := opts.Binary
	if binary == "" {
		binary = defaultGitBinary
	}
	branch := opts.DefaultBranch
	if branch == "" {
		branch = defaultBranch
	}
	if opts.ManagedRoot == "" {
		return nil, errors.New("gitworktree: ManagedRoot is required")
	}
	if opts.RepoResolver == nil {
		return nil, errors.New("gitworktree: RepoResolver is required")
	}
	root, err := physicalAbs(opts.ManagedRoot)
	if err != nil {
		return nil, fmt.Errorf("gitworktree: managed root: %w", err)
	}
	return &Workspace{
		binary:        binary,
		managedRoot:   filepath.Clean(root),
		defaultBranch: branch,
		repos:         opts.RepoResolver,
		run:           runCommand,
		runEnv:        runCommandEnv,
	}, nil
}

// Create adds a git worktree for the session under the managed root, checking
// out the requested branch, and returns where it landed.
func (w *Workspace) Create(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if err := validateConfig(cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	// Git worktrees share metadata in the source repository. Keep that small
	// critical section exclusive while callers continue provisioning and
	// launching their sessions concurrently after Create returns.
	w.worktreeMetadataMu.Lock()
	defer w.worktreeMetadataMu.Unlock()

	repo, err := w.repoPath(cfg.ProjectID)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if err := w.validateBranch(ctx, repo, cfg.Branch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	path, err := w.managedPath(cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if info, ok, err := w.existingWorktree(ctx, repo, path, cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	} else if ok {
		return info, nil
	}
	if err := w.addWorktree(ctx, repo, path, cfg.Branch, cfg.BaseBranch, cfg.SkipCheckoutHooks); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
}

// Restore re-attaches to an existing worktree for the session if one is still
// present, recreating the handle without disturbing its contents.
func (w *Workspace) Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if err := validateConfig(cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	w.worktreeMetadataMu.Lock()
	defer w.worktreeMetadataMu.Unlock()

	repo, err := w.repoPathForConfig(cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	path, err := w.restorePath(cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if rec, ok := findWorktree(records, path); ok {
		branch := rec.Branch
		if branch == "" {
			branch = cfg.Branch
		}
		return ports.WorkspaceInfo{Path: path, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, nil
	}
	if nonEmpty, err := pathExistsNonEmpty(path); err != nil {
		return ports.WorkspaceInfo{}, err
	} else if nonEmpty {
		if cfg.Path == "" {
			return ports.WorkspaceInfo{}, fmt.Errorf("gitworktree: refusing to restore %q: path exists and is not a registered worktree", path)
		}
		if _, err := moveStrayPathAside(path); err != nil {
			return ports.WorkspaceInfo{}, err
		}
	}
	if err := w.validateBranch(ctx, repo, cfg.Branch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if err := w.addWorktree(ctx, repo, path, cfg.Branch, cfg.BaseBranch, cfg.SkipCheckoutHooks); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, nil
}

// Destroy removes the session's worktree and prunes it from the repo, refusing
// (rather than force-deleting) if git still has the path registered afterwards.
func (w *Workspace) Destroy(ctx context.Context, info ports.WorkspaceInfo) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	w.worktreeMetadataMu.Lock()
	defer w.worktreeMetadataMu.Unlock()

	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	_, removeErr := w.run(ctx, w.binary, worktreeRemoveArgs(repo, path)...)
	if err := w.pruneWorktrees(ctx, repo); err != nil {
		return err
	}
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return err
	}
	if _, ok := findWorktree(records, path); ok {
		if removeErr != nil {
			// Distinguish the dirty-worktree refusal (uncommitted agent work)
			// from other registration leftovers (e.g. a locked worktree) so the
			// Session Manager can preserve the workspace without erroring.
			dirty, statusErr := w.isDirty(ctx, path)
			if statusErr == nil && dirty {
				return fmt.Errorf("gitworktree: refusing to remove %q: %w (worktree remove: %w)", path, ports.ErrWorkspaceDirty, removeErr)
			}
			if statusErr != nil {
				// A failed probe must stay visible: without it the caller can't
				// tell "not dirty" from "couldn't check".
				return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune (worktree remove: %w; dirty probe: %w)", path, removeErr, statusErr)
			}
			return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune (worktree remove: %w)", path, removeErr)
		}
		return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune", path)
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("gitworktree: remove unregistered path %q: %w", path, err)
	}
	return nil
}

// ForceDestroy removes the session's worktree unconditionally (--force), prunes
// it from git's worktree list, and falls back to os.RemoveAll if any filesystem
// residue remains.
//
// IMPORTANT: only safe to call AFTER the session's uncommitted work has been
// captured via StashUncommitted. Calling it before capture silently
// discards agent work. For interactive teardown (ao session kill, ao cleanup)
// use Destroy, which refuses dirty worktrees via ErrWorkspaceDirty.
func (w *Workspace) ForceDestroy(ctx context.Context, info ports.WorkspaceInfo) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	w.worktreeMetadataMu.Lock()
	defer w.worktreeMetadataMu.Unlock()

	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	return w.forceDestroyPath(ctx, repo, path)
}

func (w *Workspace) existingWorktree(ctx context.Context, repo, path string, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, bool, error) {
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return ports.WorkspaceInfo{}, false, err
	}
	if rec, ok := findWorktree(records, path); ok {
		branch := rec.Branch
		if branch == "" {
			branch = cfg.Branch
		}
		return ports.WorkspaceInfo{Path: path, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, true, nil
	}
	return ports.WorkspaceInfo{}, false, nil
}

func (w *Workspace) addWorktree(ctx context.Context, repo, path, branch, baseBranch string, skipCheckoutHooks bool) error {
	// Refuse early if the branch is already checked out in another worktree:
	// `git worktree add` will fail, but its stderr leaks through as an opaque
	// 500. A typed sentinel lets the HTTP layer surface a 409.
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return err
	}
	if conflict, ok := findWorktreeByBranch(records, branch); ok && filepath.Clean(conflict.Path) != filepath.Clean(path) {
		return fmt.Errorf("%w: %q is checked out at %s", ErrBranchCheckedOutElsewhere, branch, conflict.Path)
	}

	localBranch, err := w.refExists(ctx, repo, "refs/heads/"+branch)
	if err != nil {
		return err
	}
	add := worktreeAdd{repo: repo, path: path, branch: branch, skipCheckoutHooks: skipCheckoutHooks}
	if !localBranch {
		// `worktree add -b <branch> <path> <base>` creates a fresh local branch
		// from <base>; resolveBaseRef picks the base or reports
		// ErrBranchNotFetched when none is reachable.
		add.baseRef, err = w.resolveBaseRef(ctx, repo, branch, baseBranch)
		if err != nil {
			return err
		}
		add.newBranch = true
	}
	return w.addWorktreeRecovering(ctx, add)
}

// worktreeAdd describes one `git worktree add` invocation. newBranch selects
// the `-b <branch> <path> <baseRef>` form; otherwise the existing-branch
// `<path> <branch>` form is used and baseRef is ignored. repoName is set only
// for workspace-project repos and prefixes error messages with the repo the
// add was for.
type worktreeAdd struct {
	repo              string
	path              string
	branch            string
	baseRef           string
	newBranch         bool
	skipCheckoutHooks bool
	repoName          string
}

func (a worktreeAdd) args(w *Workspace) []string {
	hooks := w.checkoutHooksPath(a.skipCheckoutHooks)
	if a.newBranch {
		return worktreeAddNewBranchArgs(a.repo, a.branch, a.path, a.baseRef, hooks)
	}
	return worktreeAddBranchArgs(a.repo, a.path, a.branch, hooks)
}

// describe renders the invocation for error messages, e.g.
// `worktree add branch "x" from "origin/main"`.
func (a worktreeAdd) describe() string {
	var b strings.Builder
	if a.repoName != "" {
		fmt.Fprintf(&b, "workspace repo %q ", a.repoName)
	}
	if a.newBranch {
		fmt.Fprintf(&b, "worktree add branch %q from %q", a.branch, a.baseRef)
	} else {
		fmt.Fprintf(&b, "worktree add existing branch %q", a.branch)
	}
	return b.String()
}

// addWorktreeRecovering runs `git worktree add`, recovering once from each of
// the two known transient failure modes:
//   - a stale registration ("missing but already registered worktree", left by
//     a crashed prior session) is pruned and the add re-run;
//   - the Windows MSYS hook fork crash is cleaned up (force remove + prune)
//     and retried via retryAddAfterHookCrash.
//
// The final failed attempt is wrapped with ports.ErrWorkspaceProvisionFailed
// so the service layer can map it to a typed non-500 API error.
func (w *Workspace) addWorktreeRecovering(ctx context.Context, a worktreeAdd) error {
	_, err := w.run(ctx, w.binary, a.args(w)...)
	if err == nil {
		return nil
	}
	switch {
	case isMissingRegisteredWorktreeError(err):
		if pruneErr := w.pruneWorktrees(ctx, a.repo); pruneErr != nil {
			return fmt.Errorf("gitworktree: %s: recover stale registration: %w", a.describe(), pruneErr)
		}
		if _, retryErr := w.run(ctx, w.binary, a.args(w)...); retryErr == nil {
			return nil
		}
	case isTransientWorktreeAddError(err):
		retryErr := w.retryAddAfterHookCrash(ctx, a)
		if retryErr == nil {
			return nil
		}
		return fmt.Errorf("gitworktree: %s: retried once after transient hook crash: %w", a.describe(), provisionFailedError(retryErr))
	}
	return fmt.Errorf("gitworktree: %s: %w", a.describe(), provisionFailedError(err))
}

// retryAddAfterHookCrash cleans up after a transient hook-crash `worktree add`
// failure and retries the add exactly once: the partially created worktree is
// force-removed, stale registrations are pruned, then the same add is re-run.
// A crashed `-b` attempt may already have created the branch (git creates it
// before the checkout hooks run); newBranch retries re-probe the ref and use
// the existing-branch form in that case instead of failing `-b` on
// "branch already exists".
func (w *Workspace) retryAddAfterHookCrash(ctx context.Context, a worktreeAdd) error {
	if err := w.forceDestroyPath(ctx, a.repo, a.path); err != nil {
		return err
	}
	if err := w.pruneWorktrees(ctx, a.repo); err != nil {
		return err
	}
	if a.newBranch {
		exists, err := w.refExists(ctx, a.repo, "refs/heads/"+a.branch)
		if err != nil {
			return err
		}
		if exists {
			a.newBranch = false
		}
	}
	_, err := w.run(ctx, w.binary, a.args(w)...)
	return err
}

func isMissingRegisteredWorktreeError(err error) bool {
	return strings.Contains(err.Error(), "is a missing but already registered worktree")
}

// isTransientWorktreeAddError reports whether a failed `worktree add` carries
// the MSYS fork-crash signature: on Windows, repos whose checkout hooks run
// via MSYS sh (e.g. Git LFS post-checkout) can die in fork() and fail the add
// even though the repo and arguments are fine, so one retry usually succeeds.
// Deliberately narrow — a bare non-zero exit (e.g. 254) without the fork noise
// never matches.
func isTransientWorktreeAddError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "dofork") ||
		strings.Contains(msg, "fork: retry: resource temporarily unavailable") ||
		strings.Contains(msg, "fork: resource temporarily unavailable")
}

// provisionStderrExcerptLimit caps how much git output rides inside an
// ErrWorkspaceProvisionFailed wrap. Hook crashes spew many retry lines; the
// API envelope only needs enough to diagnose, not the full transcript.
const provisionStderrExcerptLimit = 500

// provisionFailedError marks the final failed `worktree add` attempt with
// ports.ErrWorkspaceProvisionFailed so the service layer can map it to a typed
// non-500 API error. commandError.Error() embeds the full combined output, so
// the message is rebuilt here around a bounded excerpt instead of wrapping the
// command error verbatim (which would push the whole hook transcript into the
// envelope).
func provisionFailedError(err error) error {
	var cmdErr commandError
	if !errors.As(err, &cmdErr) {
		return fmt.Errorf("%w: %v", ports.ErrWorkspaceProvisionFailed, err)
	}
	excerpt := boundedExcerpt(cmdErr.output, provisionStderrExcerptLimit)
	if excerpt == "" {
		return fmt.Errorf("%w: %s: %v", ports.ErrWorkspaceProvisionFailed, strings.Join(cmdErr.args, " "), cmdErr.err)
	}
	return fmt.Errorf("%w: %s: %v: %s", ports.ErrWorkspaceProvisionFailed, strings.Join(cmdErr.args, " "), cmdErr.err, excerpt)
}

// boundedExcerpt trims s and, when it exceeds limit, keeps the head and tail
// halves around an elision marker so both the first crash lines and git's
// final fatal line survive.
func boundedExcerpt(s string, limit int) string {
	s = strings.TrimSpace(s)
	if len(s) <= limit {
		return s
	}
	half := limit / 2
	return s[:half] + " [...] " + s[len(s)-half:]
}

func (w *Workspace) checkoutHooksPath(skip bool) string {
	if !skip {
		return ""
	}
	// The path intentionally does not exist. Git treats a missing hooksPath as
	// an empty hook directory, avoiding repository post-checkout hooks only for
	// the AO-owned reviewer worktree that requested this mode.
	return filepath.Join(w.managedRoot, ".ao-disabled-checkout-hooks")
}

func (w *Workspace) forceDestroyPath(ctx context.Context, repo, path string) error {
	// --force bypasses git's dirty check; errors here are advisory (the path may
	// already be gone). We proceed to prune regardless.
	_, _ = w.run(ctx, w.binary, worktreeForceRemoveArgs(repo, path)...)
	if err := w.pruneWorktrees(ctx, repo); err != nil {
		return err
	}
	// os.RemoveAll as a backstop: cleans up filesystem residue left behind if
	// git worktree remove --force still left the directory (e.g. files outside
	// git tracking).
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("gitworktree: force remove path %q: %w", path, err)
	}
	return nil
}

func (w *Workspace) pruneWorktrees(ctx context.Context, repo string) error {
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
	}
	return nil
}

func validateConfig(cfg ports.WorkspaceConfig) error {
	if cfg.ProjectID == "" {
		return errors.New("gitworktree: project id is required")
	}
	if err := validatePathComponent("project id", string(cfg.ProjectID)); err != nil {
		return err
	}
	if cfg.Kind == domain.KindOrchestrator {
		prefix := resolvedSessionPrefix(cfg)
		if err := validatePathComponent("session prefix", prefix); err != nil {
			return err
		}
	} else {
		if cfg.SessionID == "" {
			return errors.New("gitworktree: session id is required")
		}
		if err := validatePathComponent("session id", string(cfg.SessionID)); err != nil {
			return err
		}
	}
	if cfg.Branch == "" {
		return errors.New("gitworktree: branch is required")
	}
	return nil
}

func (w *Workspace) repoPath(project domain.ProjectID) (string, error) {
	repo, err := w.repos.RepoPath(project)
	if err != nil {
		return "", err
	}
	if repo == "" {
		return "", fmt.Errorf("gitworktree: no repo configured for project %q", project)
	}
	abs, err := physicalAbs(repo)
	if err != nil {
		return "", fmt.Errorf("gitworktree: repo path: %w", err)
	}
	return abs, nil
}

func (w *Workspace) repoPathForInfo(info ports.WorkspaceInfo) (string, error) {
	if info.RepoPath != "" {
		repo, err := physicalAbs(info.RepoPath)
		if err != nil {
			return "", fmt.Errorf("gitworktree: repo path: %w", err)
		}
		return repo, nil
	}
	if info.ProjectID == "" {
		return "", errors.New("gitworktree: project id is required")
	}
	return w.repoPath(info.ProjectID)
}

func (w *Workspace) repoPathForConfig(cfg ports.WorkspaceConfig) (string, error) {
	if cfg.RepoPath != "" {
		repo, err := physicalAbs(cfg.RepoPath)
		if err != nil {
			return "", fmt.Errorf("gitworktree: repo path: %w", err)
		}
		return repo, nil
	}
	return w.repoPath(cfg.ProjectID)
}
