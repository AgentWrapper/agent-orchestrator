package controllers

import (
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	prsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pr"
)

// PRsController owns the /prs action routes.
type PRsController struct {
	Svc prsvc.ActionManager
}

// Register mounts the PR action routes on the supplied router.
func (c *PRsController) Register(r chi.Router) {
	r.Post("/prs/{id}/merge", c.merge)
	r.Post("/prs/{id}/close", c.close)
	r.Post("/prs/{id}/resolve-comments", c.resolveComments)
}

func (c *PRsController) merge(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/prs/{id}/merge")
		return
	}
	prID := chi.URLParam(r, "id")
	res, err := c.Svc.Merge(r.Context(), prID)
	if err != nil {
		writePRError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, MergePRResponse{OK: true, PRNumber: res.PRNumber, Method: res.Method})
}

func (c *PRsController) close(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/prs/{id}/close")
		return
	}
	prID := chi.URLParam(r, "id")
	res, err := c.Svc.Close(r.Context(), prID)
	if err != nil {
		writePRError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ClosePRResponse{OK: true, PRNumber: res.PRNumber})
}

func (c *PRsController) resolveComments(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/prs/{id}/resolve-comments")
		return
	}
	prID := chi.URLParam(r, "id")

	// Body is optional: omitting it resolves all unresolved threads.
	var in ResolveCommentsRequest
	if err := decodeJSON(r, &in); err != nil && !isEmptyBody(err) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}

	res, err := c.Svc.ResolveComments(r.Context(), prID, in.CommentIDs)
	if err != nil {
		writePRError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ResolveCommentsResponse{OK: true, Resolved: res.Resolved})
}

// writePRError maps PR sentinel errors to their locked HTTP envelopes,
// falling back to 500 for unexpected failures.
func writePRError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, prsvc.ErrPRNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PR_NOT_FOUND", "Unknown PR", nil)
	case errors.Is(err, prsvc.ErrPRNotMergeable):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "PR_NOT_MERGEABLE", "PR is not mergeable", nil)
	case errors.Is(err, prsvc.ErrPRPreconditions):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "PR_PRECONDITIONS_UNMET", "PR merge preconditions are not met", nil)
	case errors.Is(err, prsvc.ErrNothingToResolve):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "NOTHING_TO_RESOLVE", "No unresolved review threads to resolve", nil)
	default:
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "PR_OPERATION_FAILED", "PR operation failed", nil)
	}
}

// isEmptyBody reports whether err signals an absent or empty request body.
// io.ErrUnexpectedEOF means a truncated/malformed body — bad request, not absent.
func isEmptyBody(err error) bool {
	return errors.Is(err, io.EOF)
}
