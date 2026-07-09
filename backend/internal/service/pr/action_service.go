package pr

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ActionManager is the controller-facing contract for /prs/{id} action routes.
type ActionManager interface {
	Merge(ctx context.Context, prID string) (MergeResult, error)
	ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error)
}

// MergeResult is the successful outcome of a PR merge.
type MergeResult struct {
	PRNumber int
	Method   string // always "squash" for V1
}

// ResolveResult is the successful outcome of a resolve-comments operation.
type ResolveResult struct {
	Resolved int
}

// prLocator loads a tracked PR by path id (number or URL) and its related rows.
type prLocator interface {
	GetPR(ctx context.Context, url string) (domain.PullRequest, bool, error)
	GetPRByNumber(ctx context.Context, number int) (domain.PullRequest, bool, error)
	ListChecks(ctx context.Context, prURL string) ([]domain.PullRequestCheck, error)
	ListPRComments(ctx context.Context, prURL string) ([]domain.PullRequestComment, error)
	ListPRReviewThreads(ctx context.Context, prURL string) ([]domain.PullRequestReviewThread, error)
	ListPRReviews(ctx context.Context, prURL string) ([]domain.PullRequestReview, error)
}

// prPersister writes local PR facts after a remote action succeeds.
type prPersister interface {
	WritePR(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, comments []domain.PullRequestComment) error
	WriteSCMObservation(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, reviewMode ports.ReviewWriteMode) error
}

// actionLifecycle receives PR observations after local facts are updated so
// session termination / nudges stay consistent with the new state.
type actionLifecycle interface {
	ApplyPRObservation(ctx context.Context, id domain.SessionID, o ports.PRObservation) error
}

// ActionService implements ActionManager over a local PR store and SCM actioner.
// Local state is updated only after the remote SCM operation reports success.
type ActionService struct {
	store     prLocator
	writer    prPersister
	scm       ports.PRActioner
	lifecycle actionLifecycle
	clock     func() time.Time
}

// ActionDeps are the collaborators a real ActionService needs.
type ActionDeps struct {
	Store     prLocator
	Writer    prPersister
	SCM       ports.PRActioner
	Lifecycle actionLifecycle
	Clock     func() time.Time
}

// NewActionService builds an ActionService. Prefer NewActionServiceWithDeps in
// production; this zero-arg constructor remains for tests that inject deps via
// the struct fields after construction is not needed — use WithDeps.
func NewActionService() *ActionService {
	return &ActionService{clock: time.Now}
}

// NewActionServiceWithDeps returns a fully wired ActionService.
func NewActionServiceWithDeps(d ActionDeps) *ActionService {
	s := &ActionService{
		store:     d.Store,
		writer:    d.Writer,
		scm:       d.SCM,
		lifecycle: d.Lifecycle,
		clock:     d.Clock,
	}
	if s.clock == nil {
		s.clock = time.Now
	}
	return s
}

var _ ActionManager = (*ActionService)(nil)

const mergeMethodSquash = "squash"

// Merge squash-merges the PR identified by prID via the SCM provider, then
// persists the merged fact locally and notifies lifecycle.
func (s *ActionService) Merge(ctx context.Context, prID string) (MergeResult, error) {
	if err := s.requireConfigured(); err != nil {
		return MergeResult{}, err
	}
	pr, err := s.lookupPR(ctx, prID)
	if err != nil {
		return MergeResult{}, err
	}
	if pr.Merged {
		// Already recorded as merged locally — do not invent a remote success.
		// Surface not-mergeable so the UI can refresh rather than reporting OK.
		return MergeResult{}, fmt.Errorf("%w: already merged", ErrPRNotMergeable)
	}
	if pr.Closed {
		return MergeResult{}, fmt.Errorf("%w: pr is closed", ErrPRPreconditions)
	}

	ref, err := scmPRRefFromPR(pr)
	if err != nil {
		return MergeResult{}, err
	}
	remote, err := s.scm.MergePR(ctx, ref, mergeMethodSquash)
	if err != nil {
		return MergeResult{}, mapSCMError(err)
	}
	if !remote.Merged {
		return MergeResult{}, fmt.Errorf("%w: provider did not confirm merge", ErrPRNotMergeable)
	}

	method := remote.Method
	if method == "" {
		method = mergeMethodSquash
	}
	now := s.clock()
	pr.Merged = true
	pr.Closed = false
	pr.Draft = false
	if remote.SHA != "" {
		pr.MergeCommitSHA = remote.SHA
	}
	pr.UpdatedAt = now
	pr.MergedAtProvider = now

	checks, err := s.store.ListChecks(ctx, pr.URL)
	if err != nil {
		return MergeResult{}, fmt.Errorf("list checks after merge: %w", err)
	}
	comments, err := s.store.ListPRComments(ctx, pr.URL)
	if err != nil {
		return MergeResult{}, fmt.Errorf("list comments after merge: %w", err)
	}
	if err := s.writer.WritePR(ctx, pr, checks, comments); err != nil {
		return MergeResult{}, fmt.Errorf("persist merged pr: %w", err)
	}
	if s.lifecycle != nil {
		obs := ports.PRObservation{
			Fetched:      true,
			URL:          pr.URL,
			Number:       pr.Number,
			Draft:        pr.Draft,
			Merged:       true,
			Closed:       false,
			CI:           pr.CI,
			Review:       pr.Review,
			Mergeability: pr.Mergeability,
		}
		if err := s.lifecycle.ApplyPRObservation(ctx, pr.SessionID, obs); err != nil {
			return MergeResult{}, fmt.Errorf("lifecycle after merge: %w", err)
		}
	}
	return MergeResult{PRNumber: pr.Number, Method: method}, nil
}

// ResolveComments resolves review threads on the PR via the SCM provider, then
// marks the matching local threads/comments resolved. When commentIDs is empty
// every unresolved thread on the remote PR is resolved.
func (s *ActionService) ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error) {
	if err := s.requireConfigured(); err != nil {
		return ResolveResult{}, err
	}
	pr, err := s.lookupPR(ctx, prID)
	if err != nil {
		return ResolveResult{}, err
	}
	ref, err := scmPRRefFromPR(pr)
	if err != nil {
		return ResolveResult{}, err
	}

	// Always probe the remote PR first so an explicit-id resolve still fails
	// with PR_NOT_FOUND when the path id does not resolve to a live PR.
	unresolved, err := s.scm.ListUnresolvedThreadIDs(ctx, ref)
	if err != nil {
		return ResolveResult{}, mapSCMError(err)
	}

	var threadIDs []string
	if len(commentIDs) == 0 {
		threadIDs = unresolved
	} else {
		// Caller-supplied ids are treated as thread node IDs (frontend may pass
		// either). Dedupe and drop blanks.
		seen := map[string]struct{}{}
		for _, id := range commentIDs {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			threadIDs = append(threadIDs, id)
		}
	}
	if len(threadIDs) == 0 {
		return ResolveResult{}, ErrNothingToResolve
	}

	resolvedIDs := make([]string, 0, len(threadIDs))
	for _, id := range threadIDs {
		if err := s.scm.ResolveThread(ctx, id); err != nil {
			// If nothing has succeeded yet, surface the mapped error directly.
			if len(resolvedIDs) == 0 {
				return ResolveResult{}, mapSCMError(err)
			}
			// Partial remote success: still persist what completed, then fail.
			if persistErr := s.persistResolved(ctx, pr, resolvedIDs); persistErr != nil {
				return ResolveResult{}, fmt.Errorf("persist partial resolve: %w (also: %v)", persistErr, err)
			}
			return ResolveResult{Resolved: len(resolvedIDs)}, mapSCMError(err)
		}
		resolvedIDs = append(resolvedIDs, id)
	}

	if err := s.persistResolved(ctx, pr, resolvedIDs); err != nil {
		return ResolveResult{}, fmt.Errorf("persist resolved threads: %w", err)
	}
	return ResolveResult{Resolved: len(resolvedIDs)}, nil
}

func (s *ActionService) persistResolved(ctx context.Context, pr domain.PullRequest, resolvedIDs []string) error {
	set := make(map[string]struct{}, len(resolvedIDs))
	for _, id := range resolvedIDs {
		set[id] = struct{}{}
	}
	now := s.clock()
	pr.UpdatedAt = now

	checks, err := s.store.ListChecks(ctx, pr.URL)
	if err != nil {
		return err
	}
	reviews, err := s.store.ListPRReviews(ctx, pr.URL)
	if err != nil {
		return err
	}
	threads, err := s.store.ListPRReviewThreads(ctx, pr.URL)
	if err != nil {
		return err
	}
	comments, err := s.store.ListPRComments(ctx, pr.URL)
	if err != nil {
		return err
	}

	for i := range threads {
		if _, ok := set[threads[i].ThreadID]; ok {
			threads[i].Resolved = true
			threads[i].UpdatedAt = now
		}
	}
	for i := range comments {
		if _, ok := set[comments[i].ThreadID]; ok {
			comments[i].Resolved = true
			continue
		}
		// Also match comment node IDs when the caller passed those.
		if _, ok := set[comments[i].ID]; ok {
			comments[i].Resolved = true
		}
	}

	// Prefer the SCM write path so review-thread CDC fires on resolved flips.
	// Fall back to WritePR for legacy comment-only rows when there are no threads.
	if len(threads) > 0 || len(reviews) > 0 {
		return s.writer.WriteSCMObservation(ctx, pr, checks, reviews, threads, comments, ports.ReviewWriteMerge)
	}
	return s.writer.WritePR(ctx, pr, checks, comments)
}

// lookupPR resolves the /prs/{id} path parameter against the local database.
// Numeric ids are PR numbers; URL-shaped ids look up by canonical PR URL.
func (s *ActionService) lookupPR(ctx context.Context, prID string) (domain.PullRequest, error) {
	prID = strings.TrimSpace(prID)
	if prID == "" {
		return domain.PullRequest{}, ErrPRNotFound
	}
	if strings.Contains(prID, "://") || strings.HasPrefix(prID, "github.com/") {
		url := prID
		if strings.HasPrefix(url, "github.com/") {
			url = "https://" + url
		}
		pr, ok, err := s.store.GetPR(ctx, url)
		if err != nil {
			return domain.PullRequest{}, fmt.Errorf("get pr by url: %w", err)
		}
		if !ok {
			return domain.PullRequest{}, ErrPRNotFound
		}
		return pr, nil
	}
	n, err := strconv.Atoi(prID)
	if err != nil || n <= 0 {
		return domain.PullRequest{}, ErrPRNotFound
	}
	pr, ok, err := s.store.GetPRByNumber(ctx, n)
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("get pr by number: %w", err)
	}
	if !ok {
		return domain.PullRequest{}, ErrPRNotFound
	}
	return pr, nil
}

func scmPRRefFromPR(pr domain.PullRequest) (ports.SCMPRRef, error) {
	ref := ports.SCMPRRef{
		Number: pr.Number,
		URL:    firstNonEmptyStr(pr.HTMLURL, pr.URL),
		Repo: ports.SCMRepo{
			Provider: firstNonEmptyStr(pr.Provider, "github"),
			Host:     firstNonEmptyStr(pr.Host, "github.com"),
			Repo:     pr.Repo,
		},
	}
	if pr.Repo != "" {
		parts := strings.SplitN(pr.Repo, "/", 2)
		if len(parts) == 2 {
			ref.Repo.Owner = parts[0]
			ref.Repo.Name = parts[1]
		}
	}
	if ref.Repo.Owner == "" || ref.Repo.Name == "" || ref.Number <= 0 {
		// Fall through to URL parsing in the provider when possible.
		if ref.URL == "" {
			return ports.SCMPRRef{}, fmt.Errorf("%w: pr row missing repo and url", ErrPRNotFound)
		}
	}
	return ref, nil
}

func mapSCMError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ports.ErrSCMNotFound), errors.Is(err, ports.ErrSCMPRNotFound):
		return fmt.Errorf("%w: %w", ErrPRNotFound, err)
	case errors.Is(err, ports.ErrSCMNotMergeable):
		return fmt.Errorf("%w: %w", ErrPRNotMergeable, err)
	case errors.Is(err, ports.ErrSCMUnprocessable):
		return fmt.Errorf("%w: %w", ErrPRPreconditions, err)
	case errors.Is(err, ports.ErrSCMAuthFailed):
		// Auth failures stay as opaque operation failures (500) so we do not
		// claim the PR is missing or unmergeable.
		return fmt.Errorf("pr operation auth failed: %w", err)
	default:
		return err
	}
}

func firstNonEmptyStr(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func (s *ActionService) requireConfigured() error {
	if s == nil || s.scm == nil || s.store == nil || s.writer == nil {
		return errors.New("pr: action service is not configured")
	}
	return nil
}