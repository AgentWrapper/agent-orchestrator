package review

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestPlanStatuses(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	tests := []struct {
		name string
		pr   domain.PullRequest
		runs []domain.ReviewRun
		want StateStatus
	}{
		{name: "open needs review", pr: planPR("pr1", 1, "sha1"), want: ReviewStateNeedsReview},
		{name: "draft ineligible", pr: withDraft(planPR("pr1", 1, "sha1")), want: ReviewStateIneligible},
		{name: "merged ineligible", pr: withMerged(planPR("pr1", 1, "sha1")), want: ReviewStateIneligible},
		{name: "closed ineligible", pr: withClosed(planPR("pr1", 1, "sha1")), want: ReviewStateIneligible},
		{name: "approved current sha up to date", pr: planPR("pr1", 1, "sha1"), runs: []domain.ReviewRun{
			{ID: "run-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved, CreatedAt: now},
		}, want: ReviewStateUpToDate},
		{name: "changes requested current sha", pr: planPR("pr1", 1, "sha1"), runs: []domain.ReviewRun{
			{ID: "run-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested, CreatedAt: now},
		}, want: ReviewStateChangesRequested},
		{name: "running current sha", pr: planPR("pr1", 1, "sha1"), runs: []domain.ReviewRun{
			{ID: "run-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning, CreatedAt: now},
		}, want: ReviewStateRunning},
		{name: "different sha needs review", pr: planPR("pr1", 1, "sha2"), runs: []domain.ReviewRun{
			{ID: "run-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved, CreatedAt: now},
		}, want: ReviewStateNeedsReview},
		{name: "failed current sha retryable", pr: planPR("pr1", 1, "sha1"), runs: []domain.ReviewRun{
			{ID: "run-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunFailed, CreatedAt: now},
		}, want: ReviewStateNeedsReview},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Plan([]domain.PullRequest{tt.pr}, tt.runs)
			if len(got) != 1 {
				t.Fatalf("review states = %d, want 1", len(got))
			}
			if got[0].Status != tt.want {
				t.Fatalf("status = %s, want %s; item=%+v", got[0].Status, tt.want, got[0])
			}
		})
	}
}

func planPR(url string, n int, sha string) domain.PullRequest {
	return domain.PullRequest{URL: url, Number: n, HeadSHA: sha}
}

func withDraft(pr domain.PullRequest) domain.PullRequest {
	pr.Draft = true
	return pr
}

func withMerged(pr domain.PullRequest) domain.PullRequest {
	pr.Merged = true
	return pr
}

func withClosed(pr domain.PullRequest) domain.PullRequest {
	pr.Closed = true
	return pr
}
