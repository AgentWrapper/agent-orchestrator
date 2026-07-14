package review

import (
	"sort"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// StateStatus is the per-PR review planning state.
type StateStatus string

const (
	// ReviewStateNeedsReview means an eligible PR has no current AO approval or running pass.
	ReviewStateNeedsReview StateStatus = "needs_review"
	// ReviewStateRunning means a review run is already active for the PR's current head.
	ReviewStateRunning StateStatus = "running"
	// ReviewStateUpToDate means AO approved the PR's current head.
	ReviewStateUpToDate StateStatus = "up_to_date"
	// ReviewStateChangesRequested means AO requested changes on the PR's current head.
	ReviewStateChangesRequested StateStatus = "changes_requested"
	// ReviewStateIneligible means the PR is draft, closed, merged, or missing required facts.
	ReviewStateIneligible StateStatus = "ineligible"
)

// PRReviewState is one PR-scoped review decision for a worker session.
type PRReviewState struct {
	PRURL     string            `json:"prUrl"`
	PRNumber  int               `json:"prNumber"`
	Title     string            `json:"title"`
	TargetSHA string            `json:"targetSha"`
	Status    StateStatus       `json:"status" enum:"needs_review,running,up_to_date,changes_requested,ineligible"`
	LatestRun *domain.ReviewRun `json:"latestRun,omitempty"`
}

// Plan computes per-PR review work from the currently observed PRs and existing
// review runs. It is pure so the trigger path and API list path share exactly
// the same eligibility/status rules.
func Plan(prs []domain.PullRequest, runs []domain.ReviewRun) []PRReviewState {
	latest := latestRunsByPRAndSHA(runs)
	reviews := make([]PRReviewState, 0, len(prs))
	for _, pr := range prs {
		review := PRReviewState{
			PRURL:     pr.URL,
			PRNumber:  pr.Number,
			Title:     pr.Title,
			TargetSHA: pr.HeadSHA,
			Status:    ReviewStateNeedsReview,
		}
		if pr.URL == "" || pr.HeadSHA == "" || pr.Draft || pr.Merged || pr.Closed {
			review.Status = ReviewStateIneligible
			if run, ok := latest[review.PRURL+"\x00"+review.TargetSHA]; ok {
				review.LatestRun = &run
			}
			reviews = append(reviews, review)
			continue
		}
		if run, ok := latest[review.PRURL+"\x00"+review.TargetSHA]; ok {
			review.LatestRun = &run
			switch {
			case run.Status == domain.ReviewRunRunning:
				review.Status = ReviewStateRunning
			case run.Verdict == domain.VerdictApproved:
				review.Status = ReviewStateUpToDate
			case run.Verdict == domain.VerdictChangesRequested:
				review.Status = ReviewStateChangesRequested
			case run.Status == domain.ReviewRunFailed || run.Status == domain.ReviewRunCancelled:
				review.Status = ReviewStateNeedsReview
			default:
				review.Status = ReviewStateNeedsReview
			}
		}
		reviews = append(reviews, review)
	}
	sort.SliceStable(reviews, func(i, j int) bool {
		if reviews[i].PRNumber != reviews[j].PRNumber {
			return reviews[i].PRNumber < reviews[j].PRNumber
		}
		return reviews[i].PRURL < reviews[j].PRURL
	})
	return reviews
}

func latestRunsByPRAndSHA(runs []domain.ReviewRun) map[string]domain.ReviewRun {
	latest := make(map[string]domain.ReviewRun)
	for _, run := range runs {
		if run.PRURL == "" || run.TargetSHA == "" {
			continue
		}
		key := run.PRURL + "\x00" + run.TargetSHA
		if existing, ok := latest[key]; !ok || run.CreatedAt.After(existing.CreatedAt) {
			latest[key] = run
		}
	}
	return latest
}
