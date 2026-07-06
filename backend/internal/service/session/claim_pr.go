package session

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var (
	// ErrInvalidPRRef is returned when a claim request does not name a GitHub PR URL or positive PR number.
	ErrInvalidPRRef = errors.New("session: invalid pr ref")
	// ErrPRNotFound is returned when the SCM provider has no matching pull request.
	ErrPRNotFound = errors.New("session: pr not found")
	// ErrPRNotOpen is returned when a PR is draft, merged, or closed and therefore cannot be claimed.
	ErrPRNotOpen = errors.New("session: pr not open")
	// ErrSCMUnavailable is returned when live SCM facts cannot be fetched.
	ErrSCMUnavailable = errors.New("session: scm unavailable")
	// ErrProjectMismatch is returned when the PR repository does not match the session project repository.
	ErrProjectMismatch = errors.New("session: pr project mismatch")
	// ErrSessionNotClaimable is returned when an orchestrator session tries to claim a PR.
	ErrSessionNotClaimable = errors.New("session: not claimable")
	// ErrSessionNoWorkspace is returned when a session has no workspace path to associate with PR work.
	ErrSessionNoWorkspace = errors.New("session: no workspace")
)

// ClaimPROptions controls PR claim conflict behavior.
type ClaimPROptions struct {
	AllowTakeover bool
}

// ClaimPRResult is the session PR read model returned after a claim.
type ClaimPRResult struct {
	PRs                []domain.PRFacts
	BranchChanged      bool
	TakenOverFrom      []domain.SessionID
	DonorWasTerminated bool
}

// ListPRs returns all PRs currently owned by a session, ordered for display.
func (s *Service) ListPRs(ctx context.Context, id domain.SessionID) ([]domain.PRFacts, error) {
	_, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", id, err)
	}
	if !ok {
		return nil, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return s.listPRFacts(ctx, id)
}

// ClaimPR attaches a live GitHub PR to a worker session and persists the current SCM facts atomically.
func (s *Service) ClaimPR(ctx context.Context, id domain.SessionID, ref string, opts ClaimPROptions) (ClaimPRResult, error) {
	rec, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return ClaimPRResult{}, fmt.Errorf("get %s: %w", id, err)
	}
	if !ok {
		return ClaimPRResult{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	if rec.IsTerminated {
		return ClaimPRResult{}, sessionmanagerAPIError("SESSION_TERMINATED", "Session is terminated")
	}
	if rec.Kind == domain.KindOrchestrator {
		return ClaimPRResult{}, ErrSessionNotClaimable
	}
	if strings.TrimSpace(rec.Metadata.WorkspacePath) == "" {
		return ClaimPRResult{}, ErrSessionNoWorkspace
	}
	project, ok, err := s.store.GetProject(ctx, string(rec.ProjectID))
	if err != nil {
		return ClaimPRResult{}, fmt.Errorf("project %s: %w", rec.ProjectID, err)
	}
	if !ok {
		return ClaimPRResult{}, apierr.Invalid("PROJECT_NOT_RESOLVABLE", "Project is not registered or has no repo — register it with `ao project add`", nil)
	}
	prURL, number, err := normalizePRRef(ref, project.RepoOriginURL)
	if err != nil {
		return ClaimPRResult{}, err
	}
	if err := requireSameGitHubRepo(prURL, project.RepoOriginURL); err != nil {
		return ClaimPRResult{}, err
	}
	if s.scm == nil || s.prClaimer == nil {
		return ClaimPRResult{}, ErrSCMUnavailable
	}
	repo, err := scmRepoForClaim(s.scm, project.RepoOriginURL, prURL)
	if err != nil {
		return ClaimPRResult{}, err
	}
	refSpec := ports.SCMPRRef{Repo: repo, Number: number, URL: prURL}
	obs, err := s.fetchClaimObservation(ctx, refSpec)
	if err != nil {
		return ClaimPRResult{}, err
	}
	if obs.PR.Number == 0 {
		obs.PR.Number = number
	}
	if obs.PR.URL == "" {
		obs.PR.URL = prURL
	}
	if obs.PR.Draft || obs.PR.Merged || obs.PR.Closed {
		return ClaimPRResult{}, ErrPRNotOpen
	}
	reviewMode, err := s.enrichClaimReviews(ctx, refSpec, &obs)
	if err != nil {
		return ClaimPRResult{}, err
	}
	now := s.clock().UTC()
	pr, checks, reviews, threads, comments := claimRowsFromSCM(id, obs, now)
	outcome, err := s.prClaimer.ClaimPR(ctx, pr, checks, reviews, threads, comments, reviewMode, opts.AllowTakeover)
	if err != nil {
		return ClaimPRResult{}, err
	}
	prs, err := s.listPRFacts(ctx, id)
	if err != nil {
		return ClaimPRResult{}, err
	}
	prs = claimedFirst(prs, prURL)
	// TODO: implement workspace branch checkout. Until then, leave BranchChanged
	// false and let CLI output omit the checkout line rather than claiming the
	// session was already on the PR branch.
	res := ClaimPRResult{PRs: prs, BranchChanged: false, DonorWasTerminated: outcome.OwnerTerminated}
	if outcome.PreviousOwner != "" && outcome.PreviousOwner != id {
		res.TakenOverFrom = []domain.SessionID{outcome.PreviousOwner}
	}
	return res, nil
}

func (s *Service) fetchClaimObservation(ctx context.Context, ref ports.SCMPRRef) (ports.SCMObservation, error) {
	batch, err := s.scm.FetchPullRequests(ctx, []ports.SCMPRRef{ref})
	if err != nil {
		if errors.Is(err, ports.ErrSCMNotFound) {
			return ports.SCMObservation{}, ErrPRNotFound
		}
		return ports.SCMObservation{}, fmt.Errorf("%w: %w", ErrSCMUnavailable, err)
	}
	if len(batch) == 0 {
		return ports.SCMObservation{}, ErrPRNotFound
	}
	obs := batch[0]
	if !obs.Fetched {
		return ports.SCMObservation{}, ErrSCMUnavailable
	}
	return obs, nil
}

func (s *Service) enrichClaimReviews(ctx context.Context, ref ports.SCMPRRef, obs *ports.SCMObservation) (ports.ReviewWriteMode, error) {
	review, err := s.scm.FetchReviewThreads(ctx, ref)
	if err != nil {
		if errors.Is(err, ports.ErrSCMNotFound) {
			return ports.ReviewWritePreserve, ErrPRNotFound
		}
		return ports.ReviewWritePreserve, fmt.Errorf("%w: %w", ErrSCMUnavailable, err)
	}
	if review.Decision != "" {
		obs.Review.Decision = review.Decision
	}
	obs.Review.Threads = review.Threads
	obs.Review.Reviews = review.Reviews
	obs.Review.Partial = review.Partial
	if review.Partial {
		return ports.ReviewWriteMerge, nil
	}
	return ports.ReviewWriteReplace, nil
}

func scmRepoForClaim(provider scmProvider, projectOrigin, prURL string) (ports.SCMRepo, error) {
	if repo, ok := provider.ParseRepository(projectOrigin); ok {
		return repo, nil
	}
	owner, name, _, err := parseGitHubPRURL(prURL)
	if err != nil {
		return ports.SCMRepo{}, ErrInvalidPRRef
	}
	return ports.SCMRepo{Provider: "github", Host: "github.com", Owner: owner, Name: name, Repo: owner + "/" + name}, nil
}

func claimRowsFromSCM(sessionID domain.SessionID, obs ports.SCMObservation, now time.Time) (domain.PullRequest, []domain.PullRequestCheck, []domain.PullRequestReview, []domain.PullRequestReviewThread, []domain.PullRequestComment) {
	observedAt := obs.ObservedAt
	if observedAt.IsZero() {
		observedAt = now
	}
	pr := domain.PullRequest{
		URL:                      firstNonEmpty(obs.PR.URL, obs.PR.HTMLURL),
		SessionID:                sessionID,
		Number:                   obs.PR.Number,
		Draft:                    obs.PR.Draft,
		Merged:                   obs.PR.Merged,
		Closed:                   obs.PR.Closed,
		CI:                       domain.CIState(firstNonEmpty(obs.CI.Summary, string(domain.CIUnknown))),
		Review:                   domain.ReviewDecision(firstNonEmpty(obs.Review.Decision, string(domain.ReviewNone))),
		Mergeability:             domain.Mergeability(firstNonEmpty(obs.Mergeability.State, string(domain.MergeUnknown))),
		UpdatedAt:                now,
		Provider:                 obs.Provider,
		Host:                     obs.Host,
		Repo:                     obs.Repo,
		SourceBranch:             obs.PR.SourceBranch,
		TargetBranch:             obs.PR.TargetBranch,
		HeadSHA:                  obs.PR.HeadSHA,
		Title:                    obs.PR.Title,
		Additions:                obs.PR.Additions,
		Deletions:                obs.PR.Deletions,
		ChangedFiles:             obs.PR.ChangedFiles,
		Author:                   obs.PR.Author,
		BaseSHA:                  obs.PR.BaseSHA,
		MergeCommitSHA:           obs.PR.MergeCommitSHA,
		ProviderState:            obs.PR.ProviderState,
		ProviderMergeable:        obs.PR.ProviderMergeable,
		ProviderMergeStateStatus: obs.PR.ProviderMergeStateStatus,
		HTMLURL:                  obs.PR.HTMLURL,
		CreatedAtProvider:        obs.PR.CreatedAtProvider,
		UpdatedAtProvider:        obs.PR.UpdatedAtProvider,
		MergedAtProvider:         obs.PR.MergedAtProvider,
		ClosedAtProvider:         obs.PR.ClosedAtProvider,
		ObservedAt:               observedAt,
		CIObservedAt:             observedAt,
		ReviewObservedAt:         observedAt,
	}
	checks := make([]domain.PullRequestCheck, 0, len(obs.CI.Checks))
	for _, ch := range obs.CI.Checks {
		checks = append(checks, domain.PullRequestCheck{Name: ch.Name, CommitHash: obs.CI.HeadSHA, Status: domain.PRCheckStatus(ch.Status), Conclusion: ch.Conclusion, URL: ch.URL, Details: ch.ProviderID, LogTail: ch.LogTail, CreatedAt: now})
	}
	reviews := make([]domain.PullRequestReview, 0, len(obs.Review.Reviews))
	for _, review := range obs.Review.Reviews {
		submittedAt := review.SubmittedAt
		if submittedAt.IsZero() {
			submittedAt = now
		}
		reviews = append(reviews, domain.PullRequestReview{
			ID:          review.ID,
			Author:      review.Author,
			State:       domain.ReviewDecision(firstNonEmpty(review.State, string(domain.ReviewNone))),
			URL:         review.URL,
			IsBot:       review.IsBot,
			SubmittedAt: submittedAt,
		})
	}
	threads := make([]domain.PullRequestReviewThread, 0, len(obs.Review.Threads))
	commentCount := 0
	for _, th := range obs.Review.Threads {
		commentCount += len(th.Comments)
	}
	comments := make([]domain.PullRequestComment, 0, commentCount)
	for _, th := range obs.Review.Threads {
		threads = append(threads, domain.PullRequestReviewThread{ThreadID: th.ID, Path: th.Path, Line: th.Line, Resolved: th.Resolved, IsBot: th.IsBot, UpdatedAt: now})
		for _, c := range th.Comments {
			comments = append(comments, domain.PullRequestComment{ThreadID: th.ID, ID: c.ID, Author: c.Author, File: th.Path, Line: th.Line, Body: c.Body, URL: c.URL, Resolved: th.Resolved, IsBot: c.IsBot || th.IsBot, CreatedAt: now})
		}
	}
	return pr, checks, reviews, threads, comments
}

func sessionmanagerAPIError(code, message string) error {
	return apierr.Conflict(code, message, nil)
}

func (s *Service) listPRFacts(ctx context.Context, id domain.SessionID) ([]domain.PRFacts, error) {
	prs, err := s.store.ListPRsBySession(ctx, id)
	if err != nil {
		return nil, err
	}
	facts := make([]domain.PRFacts, 0, len(prs))
	for _, pr := range prs {
		comments, err := s.store.ListPRComments(ctx, pr.URL)
		if err != nil {
			return nil, err
		}
		facts = append(facts, pullRequestFacts(pr, comments))
	}
	sortPRFacts(facts)
	return facts, nil
}

func pullRequestFacts(pr domain.PullRequest, comments []domain.PullRequestComment) domain.PRFacts {
	unresolved := false
	for _, c := range comments {
		if !c.Resolved {
			unresolved = true
			break
		}
	}
	return domain.PRFacts{URL: pr.URL, Number: pr.Number, Draft: pr.Draft, Merged: pr.Merged, Closed: pr.Closed, CI: pr.CI, Review: pr.Review, Mergeability: pr.Mergeability, ReviewComments: unresolved, UpdatedAt: pr.UpdatedAt}
}

func sortPRFacts(prs []domain.PRFacts) {
	sort.SliceStable(prs, func(i, j int) bool {
		ia, ja := prActive(prs[i]), prActive(prs[j])
		if ia != ja {
			return ia
		}
		return prs[i].UpdatedAt.After(prs[j].UpdatedAt)
	})
}

func prActive(pr domain.PRFacts) bool { return !pr.Merged && !pr.Closed }

func claimedFirst(prs []domain.PRFacts, prURL string) []domain.PRFacts {
	idx := -1
	for i, pr := range prs {
		if pr.URL == prURL {
			idx = i
			break
		}
	}
	if idx <= 0 {
		return prs
	}
	claimed := prs[idx]
	copy(prs[1:idx+1], prs[0:idx])
	prs[0] = claimed
	return prs
}

func normalizePRRef(ref, repoOrigin string) (string, int, error) {
	ref = strings.TrimPrefix(strings.TrimSpace(ref), "#")
	if ref == "" {
		return "", 0, ErrInvalidPRRef
	}
	if n, err := strconv.Atoi(ref); err == nil && n > 0 {
		owner, repo, err := githubRepoFromURL(repoOrigin)
		if err != nil {
			return "", 0, ErrInvalidPRRef
		}
		return fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repo, n), n, nil
	}
	owner, repo, n, err := parseGitHubPRURL(ref)
	if err != nil || owner == "" || repo == "" || n <= 0 {
		return "", 0, ErrInvalidPRRef
	}
	return fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repo, n), n, nil
}

func requireSameGitHubRepo(prURL, repoOrigin string) error {
	if strings.TrimSpace(repoOrigin) == "" {
		return nil
	}
	po, pr, _, err := parseGitHubPRURL(prURL)
	if err != nil {
		return ErrInvalidPRRef
	}
	ro, rr, err := githubRepoFromURL(repoOrigin)
	if err != nil {
		return ErrInvalidPRRef
	}
	if !strings.EqualFold(po, ro) || !strings.EqualFold(pr, rr) {
		return ErrProjectMismatch
	}
	return nil
}

func parseGitHubPRURL(raw string) (string, string, int, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", 0, err
	}
	if !strings.EqualFold(u.Scheme, "https") || !strings.EqualFold(u.Hostname(), "github.com") {
		return "", "", 0, ErrInvalidPRRef
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" {
		return "", "", 0, ErrInvalidPRRef
	}
	n, err := strconv.Atoi(parts[3])
	if err != nil || n <= 0 {
		return "", "", 0, ErrInvalidPRRef
	}
	return parts[0], strings.TrimSuffix(parts[1], ".git"), n, nil
}

func githubRepoFromURL(raw string) (string, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", ErrInvalidPRRef
	}
	if strings.HasPrefix(raw, "git@github.com:") {
		path := strings.TrimPrefix(raw, "git@github.com:")
		parts := strings.Split(strings.TrimSuffix(path, ".git"), "/")
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			return parts[0], parts[1], nil
		}
		return "", "", ErrInvalidPRRef
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", err
	}
	if !strings.EqualFold(u.Hostname(), "github.com") {
		return "", "", ErrInvalidPRRef
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", ErrInvalidPRRef
	}
	return parts[0], strings.TrimSuffix(parts[1], ".git"), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
