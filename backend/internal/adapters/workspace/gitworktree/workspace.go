package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
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
	binary        string
	managedRoot   string
	defaultBranch string
	repos         RepoResolver
	run           commandRunner
}

type commandRunner func(ctx context.Context, binary string, args ...string) ([]byte, error)

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
	}, nil
}

// Create adds a git worktree for the session under the managed root, checking
// out the requested branch, and returns where it landed.
func (w *Workspace) Create(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if err := validateConfig(cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	}
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
	if err := w.addWorktree(ctx, repo, path, cfg.Branch, cfg.BaseBranch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
}

// CreateWorkspaceProject materialises a root-as-repo workspace session: the
// parent repo worktree is created at the session root, then each registered
// child repo is created at its relative path inside that root. All repos share
// one branch name; if the requested branch already exists in any repo, one
// suffixed branch that is free in every repo is selected and used everywhere.
func (w *Workspace) CreateWorkspaceProject(ctx context.Context, cfg ports.WorkspaceProjectConfig) (ports.WorkspaceProjectInfo, error) {
	if err := validateWorkspaceProjectConfig(cfg); err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	rootRepo, err := physicalAbs(cfg.RootRepoPath)
	if err != nil {
		return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: root repo path: %w", err)
	}
	rootPath, err := w.managedPath(ports.WorkspaceConfig{
		ProjectID:     cfg.ProjectID,
		SessionID:     cfg.SessionID,
		Kind:          cfg.Kind,
		SessionPrefix: cfg.SessionPrefix,
		Branch:        firstNonEmpty(cfg.Branch, defaultSessionBranchName(cfg.SessionID)),
	})
	if err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	repos := make([]workspaceProjectRepo, 0, len(cfg.Repos)+1)
	repos = append(repos, workspaceProjectRepo{
		name:       domain.RootWorkspaceRepoName,
		repoPath:   rootRepo,
		outputPath: rootPath,
		baseBranch: cfg.BaseBranch,
	})
	for _, child := range cfg.Repos {
		repoPath, err := physicalAbs(child.RepoPath)
		if err != nil {
			return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: child repo %q path: %w", child.Name, err)
		}
		rel, err := cleanRelativePath(child.RelativePath)
		if err != nil {
			return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: child repo %q: %w", child.Name, err)
		}
		outPath, err := w.validateManagedPath(filepath.Join(rootPath, filepath.FromSlash(rel)))
		if err != nil {
			return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: child repo %q path: %w", child.Name, err)
		}
		repos = append(repos, workspaceProjectRepo{
			name:         child.Name,
			relativePath: rel,
			repoPath:     repoPath,
			outputPath:   outPath,
			baseBranch:   firstNonEmpty(child.BaseBranch, cfg.BaseBranch),
		})
	}
	branch, err := w.workspaceProjectBranch(ctx, repos, firstNonEmpty(cfg.Branch, defaultSessionBranchName(cfg.SessionID)))
	if err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	created := make([]workspaceProjectRepo, 0, len(repos))
	out := ports.WorkspaceProjectInfo{Worktrees: make([]ports.WorkspaceRepoInfo, 0, len(repos))}
	for _, repo := range repos {
		baseSHA, err := w.createWorkspaceProjectRepo(ctx, repo, branch)
		if err != nil {
			for i := len(created) - 1; i >= 0; i-- {
				_ = w.forceDestroyPath(ctx, created[i].repoPath, created[i].outputPath)
			}
			return ports.WorkspaceProjectInfo{}, err
		}
		created = append(created, repo)
		info := ports.WorkspaceRepoInfo{
			RepoName:     repo.name,
			RepoPath:     repo.repoPath,
			Path:         repo.outputPath,
			Branch:       branch,
			BaseSHA:      baseSHA,
			SessionID:    cfg.SessionID,
			ProjectID:    cfg.ProjectID,
			RelativePath: repo.relativePath,
		}
		out.Worktrees = append(out.Worktrees, info)
		if repo.name == domain.RootWorkspaceRepoName {
			out.Root = ports.WorkspaceInfo{Path: repo.outputPath, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}
		}
	}
	return out, nil
}

// DestroyWorkspaceProject removes every worktree in a workspace project,
// children first and the parent/root last. It uses the same force path as spawn
// rollback because normal interactive cleanup still goes through Destroy and
// the full dirty-preserve matrix is implemented separately.
func (w *Workspace) DestroyWorkspaceProject(ctx context.Context, info ports.WorkspaceProjectInfo) error {
	var firstErr error
	for i := len(info.Worktrees) - 1; i >= 0; i-- {
		wt := info.Worktrees[i]
		if wt.Path == "" {
			continue
		}
		repoPath := wt.RepoPath
		if repoPath == "" {
			if firstErr == nil {
				firstErr = fmt.Errorf("gitworktree: missing repo path for worktree %q", wt.Path)
			}
			continue
		}
		if err := w.forceDestroyPath(ctx, repoPath, wt.Path); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Destroy removes the session's worktree and prunes it from the repo, refusing
// (rather than force-deleting) if git still has the path registered afterwards.
func (w *Workspace) Destroy(ctx context.Context, info ports.WorkspaceInfo) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	_, removeErr := w.run(ctx, w.binary, worktreeRemoveArgs(repo, path)...)
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
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
// ponytail: only safe to call AFTER the session's uncommitted work has been
// captured via StashUncommitted. Calling it before capture silently
// discards agent work. For interactive teardown (ao session kill, ao cleanup)
// use Destroy, which refuses dirty worktrees via ErrWorkspaceDirty.
func (w *Workspace) ForceDestroy(ctx context.Context, info ports.WorkspaceInfo) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	// --force bypasses git's dirty check; errors here are advisory (the path may
	// already be gone). We proceed to prune regardless.
	_, _ = w.run(ctx, w.binary, worktreeForceRemoveArgs(repo, path)...)
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
	}
	// os.RemoveAll as a backstop: cleans up filesystem residue left behind if
	// git worktree remove --force still left the directory (e.g. files outside
	// git tracking).
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("gitworktree: force remove path %q: %w", path, err)
	}
	return nil
}

// StashUncommitted captures all uncommitted work in the session's worktree
// into a git commit object WITHOUT mutating the working tree or the global
// stash stack. The commit is stored at refs/ao/preserved/<session-id>.
//
// It builds the preserve commit through a temporary index file so tracked
// edits AND new non-ignored files are captured while .gitignore-d files are
// silently skipped (honoured because we never pass -f/--force to git-add).
//
// Returns the full ref name (e.g. "refs/ao/preserved/sess-1"). Returns an
// empty string (and no error) if the worktree is clean.
func (w *Workspace) StashUncommitted(ctx context.Context, info ports.WorkspaceInfo) (string, error) {
	if info.Path == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if info.SessionID == "" {
		return "", errors.New("gitworktree: session id is required for StashUncommitted")
	}

	// Early exit for clean worktrees: nothing to preserve.
	dirty, err := w.isDirty(ctx, info.Path)
	if err != nil {
		return "", fmt.Errorf("gitworktree: StashUncommitted dirty check: %w", err)
	}
	if !dirty {
		return "", nil
	}

	// Log the count of ignored paths that will be skipped.
	if skipCount, err := w.countIgnoredPaths(ctx, info.Path); err == nil {
		slog.InfoContext(ctx, "gitworktree: StashUncommitted skipping ignored paths",
			"session", string(info.SessionID),
			"skipped_count", skipCount,
		)
	}

	// Reserve a unique path for the temp index in the system temp dir (not ~/.ao).
	// We must NOT pre-create the file: git requires GIT_INDEX_FILE to either not
	// exist (it creates it) or be a valid git index. os.CreateTemp gives us a
	// unique name; we close and remove it immediately so git gets an absent path.
	tmpIdx, err := os.CreateTemp("", "ao-preserve-idx-*")
	if err != nil {
		return "", fmt.Errorf("gitworktree: reserve temp index path: %w", err)
	}
	tmpIdxPath := tmpIdx.Name()
	_ = tmpIdx.Close()
	// Remove now so git sees an absent path (not a 0-byte corrupt index).
	_ = os.Remove(tmpIdxPath)
	// Deferred remove is a best-effort cleanup in case git leaves the file.
	defer func() { _ = os.Remove(tmpIdxPath) }()

	// Stage all tracked and non-ignored untracked files into the temp index.
	// GIT_INDEX_FILE overrides the index so the real index is never touched.
	addCmd := exec.CommandContext(ctx, w.binary, addAllTempIndexArgs(info.Path)...)
	addCmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+tmpIdxPath)
	if out, err := addCmd.CombinedOutput(); err != nil {
		return "", commandError{args: append([]string{w.binary}, addAllTempIndexArgs(info.Path)...), output: string(out), err: err}
	}

	// Write the staged tree to get a tree SHA.
	writeTreeCmd := exec.CommandContext(ctx, w.binary, writeTreeArgs(info.Path)...)
	writeTreeCmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+tmpIdxPath)
	treeOut, err := writeTreeCmd.CombinedOutput()
	if err != nil {
		return "", commandError{args: append([]string{w.binary}, writeTreeArgs(info.Path)...), output: string(treeOut), err: err}
	}
	treeSHA := strings.TrimSpace(string(treeOut))

	// Resolve HEAD. An unborn HEAD (no commits yet) means we omit the -p flag
	// from commit-tree so the preserve commit has no parent.
	headOut, headErr := w.run(ctx, w.binary, revParseHeadArgs(info.Path)...)
	headSHA := ""
	if headErr == nil {
		headSHA = strings.TrimSpace(string(headOut))
	}
	// headErr != nil means unborn HEAD: headSHA stays empty, commit-tree gets no -p.

	// If the preserve tree SHA equals HEAD's tree SHA the working tree is
	// effectively clean from git's perspective (only ignored files differ).
	if headSHA != "" {
		headTreeOut, err := w.run(ctx, w.binary, "-C", info.Path, "rev-parse", headSHA+"^{tree}")
		if err == nil {
			headTreeSHA := strings.TrimSpace(string(headTreeOut))
			if headTreeSHA == treeSHA {
				// Nothing to preserve beyond ignored files.
				return "", nil
			}
		}
	}

	// Create a commit object that wraps the preserve tree.
	msg := "ao preserved " + string(info.SessionID)
	commitOut, err := w.run(ctx, w.binary, commitTreeArgs(info.Path, treeSHA, headSHA, msg)...)
	if err != nil {
		return "", fmt.Errorf("gitworktree: commit-tree: %w", err)
	}
	commitSHA := strings.TrimSpace(string(commitOut))

	// Point the preserve ref at the commit.
	ref := "refs/ao/preserved/" + string(info.SessionID)
	if _, err := w.run(ctx, w.binary, updateRefArgs(info.Path, ref, commitSHA)...); err != nil {
		return "", fmt.Errorf("gitworktree: update-ref %q: %w", ref, err)
	}
	return ref, nil
}

// countIgnoredPaths returns the number of entries listed by
// "git status --ignored --porcelain" that start with "!!" (ignored).
func (w *Workspace) countIgnoredPaths(ctx context.Context, worktree string) (int, error) {
	out, err := w.run(ctx, w.binary, ignoredCountArgs(worktree)...)
	if err != nil {
		return 0, fmt.Errorf("gitworktree: count ignored: %w", err)
	}
	count := 0
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "!! ") {
			count++
		}
	}
	return count, nil
}

// ApplyPreserved replays the capture created by StashUncommitted onto the
// (freshly re-added) worktree using a true three-way merge (cherry-pick --no-commit).
// On clean success, the preserve ref is deleted.
// On conflict, the ref is kept, conflict markers are left in the affected files,
// and ErrPreservedConflict (wrapped) is returned so the caller can surface it.
//
// NEVER deletes the preserve ref on a failed or conflicted apply.
func (w *Workspace) ApplyPreserved(ctx context.Context, info ports.WorkspaceInfo, ref string) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if ref == "" {
		return errors.New("gitworktree: ApplyPreserved: ref must not be empty")
	}

	// Resolve the ref to its commit SHA.
	resolveOut, err := w.run(ctx, w.binary, revParseVerifyArgs(info.Path, ref)...)
	if err != nil {
		return fmt.Errorf("gitworktree: ApplyPreserved resolve ref %q: %w", ref, err)
	}
	commitSHA := strings.TrimSpace(string(resolveOut))

	// Apply the preserve commit via "git cherry-pick --no-commit <sha>".
	// cherry-pick computes the diff between the preserve commit and its parent
	// (the HEAD at save time) and 3-way-merges it onto the current working tree.
	// On conflict it leaves textual conflict markers in the affected files and
	// exits non-zero WITHOUT committing or moving HEAD. Conflict detection uses
	// the exit code only (not output text) to stay locale-independent.
	applyErr := w.runCherryPickNoCommit(ctx, info.Path, commitSHA)
	if applyErr != nil {
		// Any non-zero exit from the merge step is a conflict: keep the ref,
		// leave conflict markers in place, and surface the sentinel.
		return fmt.Errorf("%w: %w", ErrPreservedConflict, applyErr)
	}

	// Clean apply: remove the preserve ref so it is never replayed twice.
	if _, err := w.run(ctx, w.binary, deleteRefArgs(info.Path, ref)...); err != nil {
		// Log but do not fail: the work is already applied. A dangling preserve
		// ref is harmless; the next StashUncommitted will overwrite it.
		slog.WarnContext(ctx, "gitworktree: ApplyPreserved could not delete preserve ref",
			"ref", ref,
			"err", err,
		)
	}
	return nil
}

// runCherryPickNoCommit runs "git -C <worktree> cherry-pick --no-commit <sha>"
// and captures combined output so any conflict details are available in the
// returned commandError. Exit code detection happens in the caller.
func (w *Workspace) runCherryPickNoCommit(ctx context.Context, worktree, commitSHA string) error {
	args := cherryPickNoCommitArgs(worktree, commitSHA)
	cmd := exec.CommandContext(ctx, w.binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return commandError{args: append([]string{w.binary}, args...), output: string(out), err: err}
	}
	return nil
}

// Restore re-attaches to an existing worktree for the session if one is still
// present, recreating the handle without disturbing its contents.
func (w *Workspace) Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if err := validateConfig(cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	}
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
	if err := w.addWorktree(ctx, repo, path, cfg.Branch, cfg.BaseBranch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, nil
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

func (w *Workspace) addWorktree(ctx context.Context, repo, path, branch, baseBranch string) error {
	// Refuse early if the branch is already checked out in another worktree:
	// `git worktree add` will fail, but its stderr leaks through as an opaque
	// 500. A typed sentinel lets the HTTP layer surface a 409.
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return err
	}
	if conflict, ok := findWorktreeByBranch(records, branch); ok && filepath.Clean(conflict.Path) != filepath.Clean(path) {
		return fmt.Errorf("%w: %q is checked out at %q", ErrBranchCheckedOutElsewhere, branch, conflict.Path)
	}

	localBranch, err := w.refExists(ctx, repo, "refs/heads/"+branch)
	if err != nil {
		return err
	}
	if localBranch {
		if _, err := w.run(ctx, w.binary, worktreeAddBranchArgs(repo, path, branch)...); err != nil {
			return fmt.Errorf("gitworktree: worktree add existing branch %q: %w", branch, err)
		}
		return nil
	}

	// `worktree add -b <branch> <path> <base>` creates a fresh local branch from
	// <base>. resolveBaseRef tries `origin/<branch>` first, so a fetched-but-
	// not-checked-out remote branch auto-tracks cleanly via that path. If
	// neither origin/<branch>, the default branch, nor any tag is reachable,
	// the branch genuinely has no base — surface ErrBranchNotFetched so callers
	// can suggest `git fetch`.
	baseRef, err := w.resolveBaseRef(ctx, repo, branch, baseBranch)
	if err != nil {
		if errors.Is(err, errNoBaseRef) {
			return fmt.Errorf("%w: %q has no local head, no remote, and no tag — run `git fetch` then retry", ErrBranchNotFetched, branch)
		}
		return err
	}
	if _, err := w.run(ctx, w.binary, worktreeAddNewBranchArgs(repo, branch, path, baseRef)...); err != nil {
		return fmt.Errorf("gitworktree: worktree add branch %q from %q: %w", branch, baseRef, err)
	}
	return nil
}

type workspaceProjectRepo struct {
	name         string
	relativePath string
	repoPath     string
	outputPath   string
	baseBranch   string
}

func (w *Workspace) workspaceProjectBranch(ctx context.Context, repos []workspaceProjectRepo, requested string) (string, error) {
	branch := strings.TrimSpace(requested)
	if branch == "" {
		return "", errors.New("gitworktree: branch is required")
	}
	for i := 0; i < 100; i++ {
		candidate := branch
		if i > 0 {
			candidate = fmt.Sprintf("%s-%d", branch, i+1)
		}
		free, err := w.workspaceProjectBranchFree(ctx, repos, candidate)
		if err != nil {
			return "", err
		}
		if free {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("gitworktree: could not find free workspace branch for %q", branch)
}

func (w *Workspace) workspaceProjectBranchFree(ctx context.Context, repos []workspaceProjectRepo, branch string) (bool, error) {
	for _, repo := range repos {
		if err := w.validateBranch(ctx, repo.repoPath, branch); err != nil {
			return false, err
		}
		exists, err := w.refExists(ctx, repo.repoPath, "refs/heads/"+branch)
		if err != nil {
			return false, err
		}
		if exists {
			return false, nil
		}
		records, err := w.listRecords(ctx, repo.repoPath)
		if err != nil {
			return false, err
		}
		if conflict, ok := findWorktreeByBranch(records, branch); ok && filepath.Clean(conflict.Path) != filepath.Clean(repo.outputPath) {
			return false, nil
		}
	}
	return true, nil
}

func (w *Workspace) createWorkspaceProjectRepo(ctx context.Context, repo workspaceProjectRepo, branch string) (string, error) {
	baseRef, err := w.resolveBaseRef(ctx, repo.repoPath, branch, repo.baseBranch)
	if err != nil {
		if errors.Is(err, errNoBaseRef) {
			return "", fmt.Errorf("%w: %q has no local head, no remote, and no tag — run `git fetch` then retry", ErrBranchNotFetched, branch)
		}
		return "", err
	}
	baseSHA, err := w.revParse(ctx, repo.repoPath, baseRef)
	if err != nil {
		return "", err
	}
	if _, err := w.run(ctx, w.binary, worktreeAddNewBranchArgs(repo.repoPath, branch, repo.outputPath, baseRef)...); err != nil {
		return "", fmt.Errorf("gitworktree: workspace repo %q worktree add branch %q from %q: %w", repo.name, branch, baseRef, err)
	}
	return baseSHA, nil
}

func (w *Workspace) forceDestroyPath(ctx context.Context, repo, path string) error {
	_, _ = w.run(ctx, w.binary, worktreeForceRemoveArgs(repo, path)...)
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("gitworktree: force remove path %q: %w", path, err)
	}
	return nil
}

func (w *Workspace) revParse(ctx context.Context, repo, ref string) (string, error) {
	out, err := w.run(ctx, w.binary, "-C", repo, "rev-parse", "--verify", ref)
	if err != nil {
		return "", fmt.Errorf("gitworktree: rev-parse %q: %w", ref, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func (w *Workspace) validateBranch(ctx context.Context, repo, branch string) error {
	if _, err := w.run(ctx, w.binary, checkRefFormatBranchArgs(repo, branch)...); err != nil {
		return fmt.Errorf("%w: %q (%w)", ErrBranchInvalid, branch, err)
	}
	return nil
}

// errNoBaseRef is an internal sentinel: every candidate base ref is missing.
// addWorktree translates it into ErrBranchNotFetched.
var errNoBaseRef = errors.New("gitworktree: no base ref found")

func (w *Workspace) resolveBaseRef(ctx context.Context, repo, branch, baseBranch string) (string, error) {
	// A per-project base branch (cfg.BaseBranch) overrides the adapter default,
	// so a project that branches off e.g. "develop" materialises worktrees from
	// there. Empty falls back to the adapter's configured default.
	defaultBranch := w.defaultBranch
	if strings.TrimSpace(baseBranch) != "" {
		defaultBranch = baseBranch
	}
	candidates := baseRefCandidates(branch, defaultBranch)
	for _, ref := range candidates {
		exists, err := w.refExists(ctx, repo, ref)
		if err != nil {
			return "", err
		}
		if exists {
			return ref, nil
		}
	}
	// Also probe a same-named tag so requests like `--branch v1.2.3` can
	// auto-track when the tag is fetched but no branch ref exists.
	tagRef := "refs/tags/" + branch
	exists, err := w.refExists(ctx, repo, tagRef)
	if err != nil {
		return "", err
	}
	if exists {
		return tagRef, nil
	}
	return "", fmt.Errorf("%w for branch %q (tried %s, %s)", errNoBaseRef, branch, strings.Join(candidates, ", "), tagRef)
}

func (w *Workspace) refExists(ctx context.Context, repo, ref string) (bool, error) {
	_, err := w.run(ctx, w.binary, revParseVerifyArgs(repo, ref)...)
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("gitworktree: verify ref %q: %w", ref, err)
}

// isDirty reports whether the worktree at path has uncommitted changes or
// untracked files — the same check `git worktree remove` performs before
// refusing without --force.
func (w *Workspace) isDirty(ctx context.Context, path string) (bool, error) {
	out, err := w.run(ctx, w.binary, statusPorcelainArgs(path)...)
	if err != nil {
		return false, fmt.Errorf("gitworktree: status %q: %w", path, err)
	}
	return strings.TrimSpace(string(out)) != "", nil
}

func (w *Workspace) listRecords(ctx context.Context, repo string) ([]worktreeRecord, error) {
	out, err := w.run(ctx, w.binary, worktreeListPorcelainArgs(repo)...)
	if err != nil {
		return nil, fmt.Errorf("gitworktree: worktree list: %w", err)
	}
	records, err := parseWorktreePorcelain(string(out))
	if err != nil {
		return nil, fmt.Errorf("gitworktree: parse worktree list: %w", err)
	}
	return records, nil
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

func physicalAbs(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}
	parent := filepath.Dir(abs)
	base := filepath.Base(abs)
	for parent != "." && parent != string(os.PathSeparator) {
		if resolved, err := filepath.EvalSymlinks(parent); err == nil {
			return filepath.Join(resolved, base), nil
		}
		base = filepath.Join(filepath.Base(parent), base)
		parent = filepath.Dir(parent)
	}
	if resolved, err := filepath.EvalSymlinks(parent); err == nil {
		return filepath.Join(resolved, base), nil
	}
	return abs, nil
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

func validateWorkspaceProjectConfig(cfg ports.WorkspaceProjectConfig) error {
	if err := validateConfig(ports.WorkspaceConfig{
		ProjectID:     cfg.ProjectID,
		SessionID:     cfg.SessionID,
		Kind:          cfg.Kind,
		SessionPrefix: cfg.SessionPrefix,
		Branch:        firstNonEmpty(cfg.Branch, defaultSessionBranchName(cfg.SessionID)),
		BaseBranch:    cfg.BaseBranch,
	}); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.RootRepoPath) == "" {
		return errors.New("gitworktree: root repo path is required")
	}
	for _, repo := range cfg.Repos {
		if strings.TrimSpace(repo.Name) == "" {
			return errors.New("gitworktree: child repo name is required")
		}
		if err := validatePathComponent("child repo name", repo.Name); err != nil {
			return err
		}
		if strings.TrimSpace(repo.RepoPath) == "" {
			return fmt.Errorf("gitworktree: child repo %q path is required", repo.Name)
		}
		if _, err := cleanRelativePath(repo.RelativePath); err != nil {
			return fmt.Errorf("gitworktree: child repo %q: %w", repo.Name, err)
		}
	}
	return nil
}

// validatePathComponent rejects id values that could escape the managed root
// once joined into a path. filepath.Join cleans `..` before validateManagedPath
// runs, so a session id of "../other" would otherwise resolve back inside
// managedRoot while breaking per-project isolation. Reject any path separator
// or the special `.`/`..` components at the source.
func validatePathComponent(name, value string) error {
	if strings.ContainsAny(value, `/\`) {
		return fmt.Errorf("%w: %s %q must not contain path separators", ErrUnsafePath, name, value)
	}
	if value == "." || value == ".." {
		return fmt.Errorf("%w: %s %q must not be a path-traversal component", ErrUnsafePath, name, value)
	}
	return nil
}

func (w *Workspace) managedPath(cfg ports.WorkspaceConfig) (string, error) {
	var path string
	if cfg.Kind == domain.KindOrchestrator {
		prefix := resolvedSessionPrefix(cfg)
		path = filepath.Join(w.managedRoot, string(cfg.ProjectID), "orchestrator", prefix+"-orchestrator")
	} else {
		path = filepath.Join(w.managedRoot, string(cfg.ProjectID), string(cfg.SessionID))
	}
	return w.validateManagedPath(path)
}

func (w *Workspace) restorePath(cfg ports.WorkspaceConfig) (string, error) {
	if cfg.Path != "" {
		return w.validateManagedPath(cfg.Path)
	}
	return w.managedPath(cfg)
}

// resolvedSessionPrefix returns cfg.SessionPrefix when set, otherwise the first
// 12 characters of the project ID (matching the display-prefix convention).
func resolvedSessionPrefix(cfg ports.WorkspaceConfig) string {
	if p := strings.TrimSpace(cfg.SessionPrefix); p != "" {
		return p
	}
	id := string(cfg.ProjectID)
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}

func defaultSessionBranchName(id domain.SessionID) string {
	return "ao/" + string(id)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func cleanRelativePath(path string) (string, error) {
	rel := filepath.ToSlash(strings.TrimSpace(path))
	if rel == "" {
		return "", errors.New("relative path is required")
	}
	if strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("%w: relative path %q must not be absolute", ErrUnsafePath, path)
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel)))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("%w: relative path %q escapes the workspace root", ErrUnsafePath, path)
	}
	return clean, nil
}

func (w *Workspace) validateManagedPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: %q is not absolute", ErrUnsafePath, path)
	}
	clean := filepath.Clean(path)
	if clean != path {
		return "", fmt.Errorf("%w: %q is not clean", ErrUnsafePath, path)
	}
	physical, err := physicalAbs(clean)
	if err != nil {
		return "", fmt.Errorf("gitworktree: resolve path %q: %w", path, err)
	}
	clean = physical
	inside, err := pathWithin(w.managedRoot, clean)
	if err != nil {
		return "", err
	}
	if !inside || clean == w.managedRoot {
		return "", fmt.Errorf("%w: %q is outside managed root %q", ErrUnsafePath, clean, w.managedRoot)
	}
	return clean, nil
}

func pathWithin(root, path string) (bool, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false, fmt.Errorf("gitworktree: compare paths: %w", err)
	}
	return rel == "." || (rel != "" && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))), nil
}

func findWorktree(records []worktreeRecord, path string) (worktreeRecord, bool) {
	clean := filepath.Clean(path)
	for _, rec := range records {
		if filepath.Clean(rec.Path) == clean {
			return rec, true
		}
	}
	return worktreeRecord{}, false
}

func findWorktreeByBranch(records []worktreeRecord, branch string) (worktreeRecord, bool) {
	for _, rec := range records {
		if rec.Branch == branch {
			return rec, true
		}
	}
	return worktreeRecord{}, false
}

func pathExistsNonEmpty(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err == nil {
		return len(entries) > 0, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, fmt.Errorf("gitworktree: inspect path %q: %w", path, err)
}

func moveStrayPathAside(path string) (string, error) {
	for i := 0; i < 100; i++ {
		candidate := path + ".stray"
		if i > 0 {
			candidate = fmt.Sprintf("%s.stray-%d", path, i+1)
		}
		if _, err := os.Lstat(candidate); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("gitworktree: inspect stray destination %q: %w", candidate, err)
		}
		if err := os.Rename(path, candidate); err != nil {
			return "", fmt.Errorf("gitworktree: move stray path %q aside to %q: %w", path, candidate, err)
		}
		return candidate, nil
	}
	return "", fmt.Errorf("gitworktree: move stray path %q aside: no available destination", path)
}

func runCommand(ctx context.Context, binary string, args ...string) ([]byte, error) {
	cmd := aoprocess.CommandContext(ctx, binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, commandError{args: append([]string{binary}, args...), output: string(out), err: err}
	}
	return out, nil
}

type commandError struct {
	args   []string
	output string
	err    error
}

func (e commandError) Error() string {
	if strings.TrimSpace(e.output) == "" {
		return fmt.Sprintf("%s: %v", strings.Join(e.args, " "), e.err)
	}
	return fmt.Sprintf("%s: %v: %s", strings.Join(e.args, " "), e.err, strings.TrimSpace(e.output))
}

func (e commandError) Unwrap() error { return e.err }
