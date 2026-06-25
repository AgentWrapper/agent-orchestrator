package controllers_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
)

type fakeReviewService struct {
	triggerErr error
	trigger    reviewcore.TriggerResult
	list       reviewcore.SessionReviews
	submitted  []reviewsvc.SubmittedReview
}

func (f *fakeReviewService) Trigger(context.Context, domain.SessionID) (reviewcore.TriggerResult, error) {
	if f.triggerErr != nil {
		return reviewcore.TriggerResult{}, f.triggerErr
	}
	if f.trigger.ReviewerHandleID != "" || f.trigger.Run.ID != "" || f.trigger.Reviews != nil || f.trigger.CreatedRuns != nil {
		return f.trigger, nil
	}
	return reviewcore.TriggerResult{Run: domain.ReviewRun{ID: "run-1"}, Created: true}, nil
}

func (f *fakeReviewService) Submit(context.Context, domain.SessionID, string, domain.ReviewVerdict, string, string) (domain.ReviewRun, error) {
	return domain.ReviewRun{}, nil
}

func (f *fakeReviewService) SubmitMany(_ context.Context, _ domain.SessionID, reviews []reviewsvc.SubmittedReview) ([]domain.ReviewRun, error) {
	f.submitted = append([]reviewsvc.SubmittedReview(nil), reviews...)
	runs := make([]domain.ReviewRun, 0, len(reviews))
	for _, review := range reviews {
		runs = append(runs, domain.ReviewRun{ID: review.RunID, Verdict: review.Verdict, Body: review.Body, GithubReviewID: review.GithubReviewID})
	}
	return runs, nil
}

func (f *fakeReviewService) List(context.Context, domain.SessionID) (reviewcore.SessionReviews, error) {
	return f.list, nil
}

func newReviewTestServer(t *testing.T, svc reviewsvc.Manager) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Reviews: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestReviewsTrigger_MissingReviewerBinaryReturns422WithCause(t *testing.T) {
	err := fmt.Errorf("launch reviewer: reviewer command: claude: %w", ports.ErrAgentBinaryNotFound)
	srv := newReviewTestServer(t, &fakeReviewService{triggerErr: err})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/sessions/mer-1/reviews/trigger", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusUnprocessableEntity, "REVIEWER_BINARY_NOT_FOUND")

	var got errorBody
	mustJSON(t, body, &got)
	if !strings.Contains(got.Message, "claude") || !strings.Contains(got.Message, ports.ErrAgentBinaryNotFound.Error()) {
		t.Fatalf("message = %q, want reviewer binary cause", got.Message)
	}
}

func TestReviewsListIncludesReviewStates(t *testing.T) {
	srv := newReviewTestServer(t, &fakeReviewService{list: reviewcore.SessionReviews{
		ReviewerHandleID: "review-mer-1",
		Runs:             []domain.ReviewRun{{ID: "run-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1"}},
		Reviews:          []reviewcore.PRReviewState{{PRURL: "https://github.com/o/r/pull/1", PRNumber: 1, TargetSHA: "sha1", Status: reviewcore.ReviewStateUpToDate}},
	}})

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/sessions/mer-1/reviews", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s", status, body)
	}
	if !strings.Contains(string(body), `"reviews"`) || !strings.Contains(string(body), `"up_to_date"`) || !strings.Contains(string(body), `"reviewerHandleId":"review-mer-1"`) {
		t.Fatalf("body missing review states/handle: %s", body)
	}
	if strings.Contains(string(body), `"items"`) || strings.Contains(string(body), `"reviewItems"`) || strings.Contains(string(body), `"reviewRuns"`) {
		t.Fatalf("body contains deprecated review item aliases: %s", body)
	}
}

func TestReviewsTriggerIncludesBatchFields(t *testing.T) {
	run1 := domain.ReviewRun{ID: "run-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1"}
	run2 := domain.ReviewRun{ID: "run-2", PRURL: "https://github.com/o/r/pull/2", TargetSHA: "sha2"}
	srv := newReviewTestServer(t, &fakeReviewService{trigger: reviewcore.TriggerResult{
		Run:              run1,
		ReviewerHandleID: "review-mer-1",
		Created:          true,
		CreatedRuns:      []domain.ReviewRun{run1, run2},
		Reviews: []reviewcore.PRReviewState{
			{PRURL: run1.PRURL, PRNumber: 1, TargetSHA: run1.TargetSHA, Status: reviewcore.ReviewStateRunning, LatestRun: &run1},
			{PRURL: run2.PRURL, PRNumber: 2, TargetSHA: run2.TargetSHA, Status: reviewcore.ReviewStateRunning, LatestRun: &run2},
		},
	}})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/sessions/mer-1/reviews/trigger", "")
	assertJSON(t, headers)
	if status != http.StatusCreated {
		t.Fatalf("status = %d body=%s", status, body)
	}
	for _, want := range []string{`"reviews"`, `"running"`, `"run-1"`, `"run-2"`, `"reviewerHandleId":"review-mer-1"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	for _, unwanted := range []string{`"reviewItems"`, `"items"`, `"createdReviews"`, `"createdRuns"`, `"reviewRuns"`, `"review":`} {
		if strings.Contains(string(body), unwanted) {
			t.Fatalf("body contains deprecated field %s: %s", unwanted, body)
		}
	}
}

func TestReviewsSubmitAcceptsBatchedReviews(t *testing.T) {
	svc := &fakeReviewService{}
	srv := newReviewTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/sessions/mer-1/reviews/submit", `{"reviews":[{"runId":"run-1","verdict":"changes_requested","body":"fix auth","githubReviewId":"101"},{"runId":"run-2","verdict":"approved"}]}`)
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s", status, body)
	}
	if len(svc.submitted) != 2 || svc.submitted[0].RunID != "run-1" || svc.submitted[1].Verdict != domain.VerdictApproved {
		t.Fatalf("submitted = %+v", svc.submitted)
	}
	for _, want := range []string{`"reviews"`, `"run-1"`, `"run-2"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
}
