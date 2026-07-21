package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

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
	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return "", err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("gitworktree: stale worktree %q: %w", path, ports.ErrWorkspaceStale)
		}
		return "", fmt.Errorf("gitworktree: stat worktree %q: %w", path, err)
	}
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return "", err
	}
	if _, ok := findWorktree(records, path); !ok {
		return "", fmt.Errorf("gitworktree: worktree %q is not registered: %w", path, ports.ErrWorkspaceStale)
	}

	// Early exit for clean worktrees: nothing to preserve.
	dirty, err := w.isDirty(ctx, path)
	if err != nil {
		if isNotGitRepositoryError(err) {
			return "", fmt.Errorf("gitworktree: stale worktree %q: %w", path, ports.ErrWorkspaceStale)
		}
		return "", fmt.Errorf("gitworktree: StashUncommitted dirty check: %w", err)
	}
	if !dirty {
		return "", nil
	}

	// Log the count of ignored paths that will be skipped.
	if skipCount, err := w.countIgnoredPaths(ctx, path); err == nil {
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
	tmpIdxEnv := []string{"GIT_INDEX_FILE=" + tmpIdxPath}
	if _, err := w.runEnv(ctx, tmpIdxEnv, w.binary, addAllTempIndexArgs(path)...); err != nil {
		return "", err
	}

	// Write the staged tree to get a tree SHA.
	treeOut, err := w.runEnv(ctx, tmpIdxEnv, w.binary, writeTreeArgs(path)...)
	if err != nil {
		return "", err
	}
	treeSHA := strings.TrimSpace(string(treeOut))

	// Resolve HEAD. An unborn HEAD (no commits yet) means we omit the -p flag
	// from commit-tree so the preserve commit has no parent.
	headOut, headErr := w.run(ctx, w.binary, revParseHeadArgs(path)...)
	headSHA := ""
	if headErr == nil {
		headSHA = strings.TrimSpace(string(headOut))
	}
	// headErr != nil means unborn HEAD: headSHA stays empty, commit-tree gets no -p.

	// If the preserve tree SHA equals HEAD's tree SHA the working tree is
	// effectively clean from git's perspective (only ignored files differ).
	if headSHA != "" {
		if headTreeSHA, err := w.revParse(ctx, path, headSHA+"^{tree}"); err == nil && headTreeSHA == treeSHA {
			// Nothing to preserve beyond ignored files.
			return "", nil
		}
	}

	// Create a commit object that wraps the preserve tree.
	msg := "ao preserved " + string(info.SessionID)
	commitOut, err := w.run(ctx, w.binary, commitTreeArgs(path, treeSHA, headSHA, msg)...)
	if err != nil {
		return "", fmt.Errorf("gitworktree: commit-tree: %w", err)
	}
	commitSHA := strings.TrimSpace(string(commitOut))

	// Point the preserve ref at the commit.
	ref := "refs/ao/preserved/" + string(info.SessionID)
	if _, err := w.run(ctx, w.binary, updateRefArgs(path, ref, commitSHA)...); err != nil {
		return "", fmt.Errorf("gitworktree: update-ref %q: %w", ref, err)
	}
	return ref, nil
}

func isNotGitRepositoryError(err error) bool {
	return strings.Contains(err.Error(), "not a git repository")
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
	if _, applyErr := w.run(ctx, w.binary, cherryPickNoCommitArgs(info.Path, commitSHA)...); applyErr != nil {
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
