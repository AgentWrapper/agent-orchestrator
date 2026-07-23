package controllers

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	trackerintakesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/trackerintake"
)

// TrackerIntakeController owns GitHub issue-intake configuration routes.
type TrackerIntakeController struct {
	Svc trackerintakesvc.Manager
}

// Register mounts tracker intake routes on the supplied router.
func (c *TrackerIntakeController) Register(r chi.Router) {
	r.Get("/tracker-intake/github/user", c.identity)
	r.Get("/projects/{id}/tracker-intake/github/labels", c.labels)
	r.Post("/projects/{id}/tracker-intake/github/preview", c.preview)
}

func (c *TrackerIntakeController) preview(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/{id}/tracker-intake/github/preview")
		return
	}
	var in TrackerIntakePreviewRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	preview, err := c.Svc.Preview(r.Context(), projectID(r), in.Labels)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, TrackerIntakePreviewResponse{Count: preview.Count})
}

func (c *TrackerIntakeController) labels(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{id}/tracker-intake/github/labels")
		return
	}
	refresh := false
	if raw := r.URL.Query().Get("refresh"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_REFRESH", "refresh must be true or false", nil)
			return
		}
		refresh = parsed
	}
	labels, err := c.Svc.Labels(r.Context(), projectID(r), refresh)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if labels == nil {
		labels = []domain.TrackerLabel{}
	}
	envelope.WriteJSON(w, http.StatusOK, TrackerIntakeLabelsResponse{Labels: labels})
}

func (c *TrackerIntakeController) identity(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/tracker-intake/github/user")
		return
	}
	user, err := c.Svc.Identity(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, TrackerIntakeIdentityResponse{Login: user.Login})
}
