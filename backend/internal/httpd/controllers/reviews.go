package controllers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
	"github.com/aoagents/agent-orchestrator/backend/internal/testgate"
)

// ReviewsController owns the session-scoped /reviews routes. A nil Svc returns 501.
type ReviewsController struct {
	Svc reviewsvc.Manager
}

// Register mounts the review routes on the supplied router.
func (c *ReviewsController) Register(r chi.Router) {
	r.Get("/sessions/{sessionId}/reviews", c.list)
	r.Post("/sessions/{sessionId}/reviews/trigger", c.trigger)
	r.Post("/sessions/{sessionId}/reviews/cancel", c.cancel)
	r.Post("/sessions/{sessionId}/reviews/submit", c.submit)
}

func (c *ReviewsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/reviews")
		return
	}
	res, err := c.Svc.List(r.Context(), sessionID(r))
	if err != nil {
		writeReviewError(w, r, err)
		return
	}
	reviews := res.Reviews
	if reviews == nil {
		reviews = []reviewcore.PRReviewState{}
	}
	envelope.WriteJSON(w, http.StatusOK, ListReviewsResponse{ReviewerHandleID: res.ReviewerHandleID, Reviews: reviews})
}

func (c *ReviewsController) trigger(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/reviews/trigger")
		return
	}
	res, err := c.Svc.Trigger(r.Context(), sessionID(r))
	if err != nil {
		writeReviewError(w, r, err)
		return
	}
	// 201 when a new pass was started; 200 when an existing run for the same
	// commit was reused.
	status := http.StatusOK
	if res.Created {
		status = http.StatusCreated
	}
	reviews := res.Reviews
	if reviews == nil {
		reviews = []reviewcore.PRReviewState{}
	}
	envelope.WriteJSON(w, status, TriggerReviewResponse{
		ReviewerHandleID: res.ReviewerHandleID,
		Reviews:          reviews,
		Created:          res.Created,
	})
}

func (c *ReviewsController) cancel(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/reviews/cancel")
		return
	}
	res, err := c.Svc.Cancel(r.Context(), sessionID(r))
	if err != nil {
		writeReviewError(w, r, err)
		return
	}
	reviews := res.Reviews
	if reviews == nil {
		reviews = []reviewcore.PRReviewState{}
	}
	envelope.WriteJSON(w, http.StatusOK, CancelReviewResponse{
		ReviewerHandleID: res.ReviewerHandleID,
		Reviews:          reviews,
	})
}

func (c *ReviewsController) submit(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/reviews/submit")
		return
	}
	var in SubmitReviewInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_BODY", "Invalid request body", nil)
		return
	}
	reviews := make([]reviewsvc.SubmittedReview, 0, len(in.Reviews))
	if len(in.Reviews) > 0 {
		for _, item := range in.Reviews {
			reviews = append(reviews, reviewsvc.SubmittedReview{
				RunID:          item.RunID,
				Verdict:        domain.ReviewVerdict(item.Verdict),
				Body:           item.Body,
				GithubReviewID: item.GithubReviewID,
				Findings:       submittedFindings(item.Findings),
			})
		}
	} else {
		reviews = append(reviews, reviewsvc.SubmittedReview{
			RunID:          in.RunID,
			Verdict:        domain.ReviewVerdict(in.Verdict),
			Body:           in.Body,
			GithubReviewID: in.GithubReviewID,
			Findings:       submittedFindings(in.Findings),
		})
	}
	runs, err := c.Svc.SubmitMany(r.Context(), sessionID(r), reviews)
	if err != nil {
		writeReviewError(w, r, err)
		return
	}
	first := domain.ReviewRun{}
	if len(runs) > 0 {
		first = runs[0]
	}
	envelope.WriteJSON(w, http.StatusOK, ReviewRunResponse{Review: first, Reviews: runs})
}

func submittedFindings(in []SubmitReviewFinding) []testgate.ReviewFinding {
	if in == nil {
		return nil
	}
	out := make([]testgate.ReviewFinding, 0, len(in))
	for _, finding := range in {
		out = append(out, testgate.ReviewFinding{
			ID:              finding.ID,
			File:            finding.File,
			Line:            finding.Line,
			Severity:        testgate.Severity(finding.Severity),
			Title:           finding.Title,
			Claim:           finding.Claim,
			FailureScenario: finding.FailureScenario,
			Behavioral:      finding.Behavioral,
		})
	}
	return out
}

func writeReviewError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, reviewsvc.ErrInvalid):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "REVIEW_INVALID", err.Error(), nil)
	case errors.Is(err, reviewsvc.ErrNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "REVIEW_NOT_FOUND", err.Error(), nil)
	case errors.Is(err, reviewsvc.ErrAgentBinaryNotFound):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "REVIEWER_BINARY_NOT_FOUND", err.Error(), nil)
	default:
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "REVIEW_OPERATION_FAILED", "Review operation failed", nil)
	}
}
