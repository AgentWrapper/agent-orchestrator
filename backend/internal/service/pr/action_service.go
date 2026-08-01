package pr

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Store is the storage dependency ActionService needs to resolve a PR and
// its unresolved-comment signal before acting on it.
type Store interface {
	GetPRByNumber(ctx context.Context, number int) (domain.PullRequest, bool, error)
	GetPRByRepoAndNumber(ctx context.Context, repo string, number int) (domain.PullRequest, bool, error)
	GetPRReviewCommentsUnresolved(ctx context.Context, url string) (bool, error)
	ListChecks(ctx context.Context, prURL string) ([]domain.PullRequestCheck, error)
	WriteSCMObservation(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, reviewMode ports.ReviewWriteMode) error
}

// SCMMerger is the SCM-provider dependency that performs the real merge.
type SCMMerger interface {
	MergePR(ctx context.Context, owner, repo string, number int, headSHA, method string) (string, error)
	RepoMergeSettings(ctx context.Context, owner, repo string) (ports.SCMRepoMergeSettings, error)
}

// ActionService implements ActionManager (declared in actions.go). It reuses
// the lifecycle interface declared in manager.go (same package) so a direct
// merge gets the same termination/cleanup reaction as an SCM-observer-driven
// merge, instead of waiting for the next poll to notice the PR is merged.
type ActionService struct {
	store     Store
	scm       SCMMerger // may be nil if the daemon started without SCM credentials
	lifecycle lifecycle // may be nil in tests that don't care about post-merge cleanup
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService wires the real store/SCM/lifecycle dependencies. scm may be
// nil (e.g. no GitHub token at startup); Merge reports ErrPRPreconditions in
// that case rather than panicking. lifecycle may be nil, in which case Merge
// skips the post-merge reaction and cleanup falls back to the next SCM
// observer pass.
func NewActionService(store Store, scm SCMMerger, lifecycle lifecycle) *ActionService {
	return &ActionService{store: store, scm: scm, lifecycle: lifecycle}
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
	checks, err := s.store.ListChecks(ctx, pr.URL)
	if err != nil {
		return MergeResult{}, err
	}
	facts.CheckCount = len(checks)
	if !domain.PRMergeReady(facts) {
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

	mergeSHA, err := s.scm.MergePR(ctx, owner, repoName, pr.Number, pr.HeadSHA, method)
	if err != nil {
		switch {
		case errors.Is(err, ports.ErrSCMPRNotMergeable):
			return MergeResult{}, ErrPRNotMergeable
		case errors.Is(err, ports.ErrSCMPRPreconditions):
			return MergeResult{}, ErrPRPreconditions
		default:
			return MergeResult{}, err
		}
	}
	now := time.Now().UTC()
	pr.Merged = true
	pr.Closed = false
	pr.Draft = false
	pr.MergeCommitSHA = mergeSHA
	pr.Mergeability = domain.MergeUnknown
	pr.ProviderState = "closed"
	pr.ProviderMergeable = "MERGED"
	pr.ProviderMergeStateStatus = "MERGED"
	pr.UpdatedAt = now
	pr.UpdatedAtProvider = now
	pr.MergedAtProvider = now
	pr.ObservedAt = now
	// From this point on, the merge on GitHub has already happened and is
	// irreversible. Everything below is best-effort local reconciliation —
	// none of it may turn into a returned error, or the API/UI will report
	// "Merge failed" and offer a Retry that would attempt to re-merge an
	// already-merged PR. Failures here are logged; the SCM observer's next
	// poll reconciles any local state that didn't get written.
	if err := s.store.WriteSCMObservation(ctx, pr, checks, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		slog.Default().Error("failed to persist merged PR snapshot after a successful provider merge; will reconcile on next SCM observation", "pr_url", pr.URL, "err", err)
	}
	// The termination/worktree cleanup that normally follows an SCM
	// observation should run now instead of waiting for the next observer
	// poll, regardless of whether the local persistence write above
	// succeeded — the merge itself is real and GitHub-confirmed either way.
	if s.lifecycle != nil {
		obs := ports.PRObservation{
			Fetched:      true,
			URL:          pr.URL,
			Number:       pr.Number,
			Draft:        pr.Draft,
			Merged:       pr.Merged,
			Closed:       pr.Closed,
			CI:           pr.CI,
			Review:       pr.Review,
			Mergeability: pr.Mergeability,
		}
		if err := s.lifecycle.ApplyPRObservation(ctx, pr.SessionID, obs); err != nil {
			slog.Default().Error("post-merge lifecycle reaction failed; will retry on next SCM observation", "pr_url", pr.URL, "session_id", pr.SessionID, "err", err)
		}
	}
	return MergeResult{PRNumber: pr.Number, Method: method}, nil
}

// pickMergeMethod prefers squash, then merge commit, then rebase — the first
// one the repo actually allows. Returns ErrPRPreconditions if none are
// enabled (all three can be disabled in branch/repo settings).
func pickMergeMethod(s ports.SCMRepoMergeSettings) (string, error) {
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
