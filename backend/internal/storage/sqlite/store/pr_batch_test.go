package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestListPRDetailsForPRsGroupsRowsInBatch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	session, _ := s.CreateSession(ctx, sampleRecord("mer"))
	now := time.Now().UTC().Truncate(time.Second)

	write := func(number int, suffix string) string {
		t.Helper()
		url := "https://github.com/o/r/pull/" + suffix
		pr := domain.PullRequest{URL: url, SessionID: session.ID, Number: number, UpdatedAt: now.Add(time.Duration(number) * time.Second)}
		checks := []domain.PullRequestCheck{{Name: "check-" + suffix, Status: domain.PRCheckPassed, CreatedAt: now}}
		reviews := []domain.PullRequestReview{{ID: "review-" + suffix, Author: "reviewer", State: domain.ReviewApproved, SubmittedAt: now}}
		comments := []domain.PullRequestComment{{ThreadID: "thread-" + suffix, ID: "comment-" + suffix, Author: "reviewer", CreatedAt: now}}
		if err := s.WriteSCMObservation(ctx, pr, checks, reviews, nil, comments, ports.ReviewWriteReplace); err != nil {
			t.Fatal(err)
		}
		return url
	}
	first := write(1, "1")
	second := write(2, "2")
	urls := []string{first, second, "missing"}

	checks, err := s.ListChecksForPRs(ctx, urls)
	if err != nil {
		t.Fatal(err)
	}
	reviews, err := s.ListPRReviewsForPRs(ctx, urls)
	if err != nil {
		t.Fatal(err)
	}
	comments, err := s.ListPRCommentsForPRs(ctx, urls)
	if err != nil {
		t.Fatal(err)
	}

	for _, url := range []string{first, second} {
		if len(checks[url]) != 1 || len(reviews[url]) != 1 || len(comments[url]) != 1 {
			t.Fatalf("batched details for %s: checks=%+v reviews=%+v comments=%+v", url, checks[url], reviews[url], comments[url])
		}
	}
	if len(checks["missing"]) != 0 || len(reviews["missing"]) != 0 || len(comments["missing"]) != 0 {
		t.Fatalf("missing PR should have empty groups")
	}
}
