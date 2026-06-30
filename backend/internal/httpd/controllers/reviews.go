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
)

// ListReviewsResponse is the body of GET /api/v1/sessions/{sessionId}/reviews.
// reviewerHandleId is the live reviewer pane's runtime handle, for the UI to
// attach its terminal over /mux (empty when no reviewer has run).
type ListReviewsResponse struct {
	ReviewerHandleID string                     `json:"reviewerHandleId"`
	Reviews          []reviewcore.PRReviewState `json:"reviews"`
}

// ReviewRunResponse is the body of submit (200). It carries the run plus the
// reviewer pane handle so the UI can attach a terminal.
type ReviewRunResponse struct {
	Review           domain.ReviewRun   `json:"review"`
	Reviews          []domain.ReviewRun `json:"reviews"`
	ReviewerHandleID string             `json:"reviewerHandleId"`
}

// TriggerReviewResponse is the body of trigger (200/201). reviews carries the
// PR-scoped review state after the trigger.
type TriggerReviewResponse struct {
	ReviewerHandleID string                     `json:"reviewerHandleId"`
	Reviews          []reviewcore.PRReviewState `json:"reviews"`
}

// SubmitReviewItem is one review result in a batched submit request.
type SubmitReviewItem struct {
	RunID          string `json:"runId" description:"Review run id being completed."`
	Verdict        string `json:"verdict" description:"Review verdict: approved or changes_requested."`
	Body           string `json:"body,omitempty" description:"Review body recorded by AO. Required for changes_requested."`
	GithubReviewID string `json:"githubReviewId,omitempty" description:"Id of the GitHub PR review the reviewer posted, if any."`
}

// SubmitReviewInput is the body of POST /api/v1/sessions/{sessionId}/reviews/submit.
type SubmitReviewInput struct {
	RunID          string             `json:"runId,omitempty" description:"Review run id being completed."`
	Verdict        string             `json:"verdict,omitempty" description:"Review verdict: approved or changes_requested."`
	Body           string             `json:"body,omitempty" description:"Review body recorded by AO. Required for changes_requested."`
	GithubReviewID string             `json:"githubReviewId,omitempty" description:"Id of the GitHub PR review the reviewer posted, if any."`
	Reviews        []SubmitReviewItem `json:"reviews,omitempty" description:"Batched review results recorded by one reviewer CLI command."`
}

// ReviewsController owns the session-scoped /reviews routes. A nil Svc returns 501.
type ReviewsController struct {
	Svc reviewsvc.Manager
}

// Register mounts the review routes on the supplied router.
func (c *ReviewsController) Register(r chi.Router) {
	r.Get("/sessions/{sessionId}/reviews", c.list)
	r.Post("/sessions/{sessionId}/reviews/trigger", c.trigger)
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
			})
		}
	} else {
		reviews = append(reviews, reviewsvc.SubmittedReview{
			RunID:          in.RunID,
			Verdict:        domain.ReviewVerdict(in.Verdict),
			Body:           in.Body,
			GithubReviewID: in.GithubReviewID,
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
