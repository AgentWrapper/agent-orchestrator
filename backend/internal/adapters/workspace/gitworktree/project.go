package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// CreateWorkspaceProject materialises a root-as-repo workspace session: the
// parent repo worktree is created at the session root, then each registered
// child repo is created at its relative path inside that root. All repos share
// one branch name; if the requested branch already exists in any repo, one
// suffixed branch that is free in every repo is selected and used everywhere.
func (w *Workspace) CreateWorkspaceProject(ctx context.Context, cfg ports.WorkspaceProjectConfig) (ports.WorkspaceProjectInfo, error) {
	if err := validateWorkspaceProjectConfig(cfg); err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	w.worktreeMetadataMu.Lock()
	defer w.worktreeMetadataMu.Unlock()

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
		name:              domain.RootWorkspaceRepoName,
		repoPath:          rootRepo,
		outputPath:        rootPath,
		baseBranch:        cfg.BaseBranch,
		skipCheckoutHooks: cfg.SkipCheckoutHooks,
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
			name:              child.Name,
			relativePath:      rel,
			repoPath:          repoPath,
			outputPath:        outPath,
			baseBranch:        firstNonEmpty(child.BaseBranch, cfg.BaseBranch),
			skipCheckoutHooks: cfg.SkipCheckoutHooks,
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
	w.worktreeMetadataMu.Lock()
	defer w.worktreeMetadataMu.Unlock()

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

type workspaceProjectRepo struct {
	name              string
	relativePath      string
	repoPath          string
	outputPath        string
	baseBranch        string
	skipCheckoutHooks bool
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
		return "", err
	}
	baseSHA, err := w.revParse(ctx, repo.repoPath, baseRef)
	if err != nil {
		return "", err
	}
	add := worktreeAdd{
		repo:              repo.repoPath,
		path:              repo.outputPath,
		branch:            branch,
		baseRef:           baseRef,
		newBranch:         true,
		skipCheckoutHooks: repo.skipCheckoutHooks,
		repoName:          repo.name,
	}
	if err := w.addWorktreeRecovering(ctx, add); err != nil {
		return "", err
	}
	return baseSHA, nil
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
