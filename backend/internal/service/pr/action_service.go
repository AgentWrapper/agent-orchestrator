package pr

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the storage dependency ActionService needs to resolve a PR and
// its unresolved-comment signal before acting on it.
type Store interface {
	GetPRByNumber(ctx context.Context, number int) (domain.PullRequest, bool, error)
	GetPRByRepoAndNumber(ctx context.Context, repo string, number int) (domain.PullRequest, bool, error)
	GetPRReviewCommentsUnresolved(ctx context.Context, url string) (bool, error)
}

// SCMMerger is the SCM-provider dependency that performs the real merge.
type SCMMerger interface {
	MergePR(ctx context.Context, owner, repo string, number int, headSHA, method string) (string, error)
	RepoMergeSettings(ctx context.Context, owner, repo string) (scmgithub.RepoMergeSettings, error)
}

// ActionService implements ActionManager (declared in actions.go).
type ActionService struct {
	store Store
	scm   SCMMerger // may be nil if the daemon started without SCM credentials
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService wires the real store/SCM dependencies. scm may be nil
// (e.g. no GitHub token at startup); Merge reports ErrPRPreconditions in
// that case rather than panicking.
func NewActionService(store Store, scm SCMMerger) *ActionService {
	return &ActionService{store: store, scm: scm}
}

// Merge merges the PR identified by id, the PR's provider number (matches the
// documented OpenAPI contract and the `ao pr merge <pr-number>` CLI). Numbers
// are only unique within one repo; GetPRByNumber reports ErrPRAmbiguous if
// this AO instance tracks the same number across more than one repo.
func (s *ActionService) Merge(ctx context.Context, id, repo string) (MergeResult, error) {
	if s.scm == nil {
		return MergeResult{}, fmt.Errorf("%w: SCM provider unavailable", ErrPRPreconditions)
	}
	number, convErr := strconv.Atoi(strings.TrimSpace(id))
	if convErr != nil || number <= 0 {
		return MergeResult{}, fmt.Errorf("%w: invalid PR number %q", ErrPRNotFound, id)
	}

	var pr domain.PullRequest
	var ok bool
	var err error
	if repo = strings.TrimSpace(repo); repo != "" {
		pr, ok, err = s.store.GetPRByRepoAndNumber(ctx, repo, number)
	} else {
		pr, ok, err = s.store.GetPRByNumber(ctx, number)
	}
	if err != nil {
		if errors.Is(err, domain.ErrPRAmbiguous) {
			return MergeResult{}, fmt.Errorf("%w: %w", ErrPRPreconditions, err)
		}
		return MergeResult{}, err
	}
	if !ok {
		return MergeResult{}, ErrPRNotFound
	}
	if pr.Merged || pr.Closed {
		return MergeResult{}, ErrPRPreconditions
	}

	unresolved, err := s.store.GetPRReviewCommentsUnresolved(ctx, pr.URL)
	if err != nil {
		return MergeResult{}, err
	}
	facts := domain.PRFacts{
		CI:             pr.CI,
		Draft:          pr.Draft,
		Review:         pr.Review,
		ReviewComments: unresolved,
		Mergeability:   pr.Mergeability,
	}
	if domain.PRPipelineStatus(facts) != domain.StatusMergeable {
		return MergeResult{}, ErrPRNotMergeable
	}

	owner, repoName, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return MergeResult{}, fmt.Errorf("%w: malformed repo %q", ErrPRPreconditions, pr.Repo)
	}

	settings, err := s.scm.RepoMergeSettings(ctx, owner, repoName)
	if err != nil {
		return MergeResult{}, err
	}
	method, err := pickMergeMethod(settings)
	if err != nil {
		return MergeResult{}, err
	}

	if _, err := s.scm.MergePR(ctx, owner, repoName, pr.Number, pr.HeadSHA, method); err != nil {
		switch {
		case errors.Is(err, scmgithub.ErrProviderPRNotMergeable):
			return MergeResult{}, ErrPRNotMergeable
		case errors.Is(err, scmgithub.ErrProviderPRPreconditions):
			return MergeResult{}, ErrPRPreconditions
		default:
			return MergeResult{}, err
		}
	}
	return MergeResult{PRNumber: pr.Number, Method: method}, nil
}

// pickMergeMethod prefers squash, then merge commit, then rebase — the first
// one the repo actually allows. Returns ErrPRPreconditions if none are
// enabled (all three can be disabled in branch/repo settings).
func pickMergeMethod(s scmgithub.RepoMergeSettings) (string, error) {
	switch {
	case s.AllowSquash:
		return "squash", nil
	case s.AllowMergeCommit:
		return "merge", nil
	case s.AllowRebase:
		return "rebase", nil
	default:
		return "", fmt.Errorf("%w: repository has no merge method enabled", ErrPRPreconditions)
	}
}

// ResolveComments is intentionally NOT implemented yet — returning a fake
// success here once PRs is wired would silently do nothing while reporting
// 200 OK. Keeping ErrNotImplemented preserves the prior 501 behavior for
// this specific operation until it's genuinely built.
func (s *ActionService) ResolveComments(_ context.Context, _ string, _ []string) (ResolveResult, error) {
	return ResolveResult{}, ErrNotImplemented
}
