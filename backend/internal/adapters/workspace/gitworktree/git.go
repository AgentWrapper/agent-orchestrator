package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// commandRunner executes one git invocation and returns its combined output.
// It is a Workspace field so tests can substitute a stub.
type commandRunner func(ctx context.Context, binary string, args ...string) ([]byte, error)

// envCommandRunner is commandRunner with extra environment variables appended
// to the inherited environment (e.g. GIT_INDEX_FILE for temp-index staging).
type envCommandRunner func(ctx context.Context, extraEnv []string, binary string, args ...string) ([]byte, error)

func runCommand(ctx context.Context, binary string, args ...string) ([]byte, error) {
	return runCommandEnv(ctx, nil, binary, args...)
}

func runCommandEnv(ctx context.Context, extraEnv []string, binary string, args ...string) ([]byte, error) {
	cmd := aoprocess.CommandContext(ctx, binary, args...)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
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

func (w *Workspace) revParse(ctx context.Context, repo, ref string) (string, error) {
	out, err := w.run(ctx, w.binary, "-C", repo, "rev-parse", "--verify", ref)
	if err != nil {
		return "", fmt.Errorf("gitworktree: rev-parse %q: %w", ref, err)
	}
	return strings.TrimSpace(string(out)), nil
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

func (w *Workspace) validateBranch(ctx context.Context, repo, branch string) error {
	if _, err := w.run(ctx, w.binary, checkRefFormatBranchArgs(repo, branch)...); err != nil {
		return fmt.Errorf("%w: %q (%w)", ErrBranchInvalid, branch, err)
	}
	return nil
}

// errNoBaseRef is an internal sentinel: every candidate base ref is missing.
// resolveBaseRef translates it into ErrBranchNotFetched.
var errNoBaseRef = errors.New("gitworktree: no base ref found")

// resolveBaseRef picks the ref a new branch is created from. resolveBaseRef
// tries `origin/<branch>` first, so a fetched-but-not-checked-out remote branch
// auto-tracks cleanly via that path. If neither origin/<branch>, the default
// branch, nor any tag is reachable, the branch genuinely has no base —
// ErrBranchNotFetched is returned so callers can suggest `git fetch`.
func (w *Workspace) resolveBaseRef(ctx context.Context, repo, branch, baseBranch string) (string, error) {
	defaultBranch := strings.TrimSpace(baseBranch)
	if defaultBranch == "" {
		defaultBranch = w.inferRepoDefaultBranch(ctx, repo)
	}
	ref, err := w.resolveBaseRefFromDefault(ctx, repo, branch, defaultBranch)
	if err != nil {
		if errors.Is(err, errNoBaseRef) {
			return "", fmt.Errorf("%w: %q has no local head, no remote, and no tag — run `git fetch` then retry", ErrBranchNotFetched, branch)
		}
		return "", err
	}
	return ref, nil
}

func (w *Workspace) resolveBaseRefFromDefault(ctx context.Context, repo, branch, defaultBranch string) (string, error) {
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

func (w *Workspace) inferRepoDefaultBranch(ctx context.Context, repo string) string {
	for _, args := range [][]string{
		{"symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"},
		{"branch", "--show-current"},
	} {
		out, err := w.run(ctx, w.binary, append([]string{"-C", repo}, args...)...)
		if err != nil {
			continue
		}
		branch := strings.TrimSpace(string(out))
		branch = strings.TrimPrefix(branch, "origin/")
		if branch != "" {
			return branch
		}
	}
	return w.defaultBranch
}
