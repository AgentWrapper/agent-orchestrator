package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	repostewardsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/reposteward"
)

type RepositoryStewardService interface {
	Status(ctx context.Context, projectID domain.ProjectID) (repostewardsvc.Status, error)
	Checkpoint(ctx context.Context, projectID domain.ProjectID) (repostewardsvc.Status, error)
}

type RepositoryStewardController struct {
	Svc RepositoryStewardService
}

func (c *RepositoryStewardController) Register(r chi.Router) {
	r.Get("/projects/{projectId}/repository-steward", c.status)
	r.Post("/projects/{projectId}/repository-steward/checkpoint", c.checkpoint)
}

func (c *RepositoryStewardController) status(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{projectId}/repository-steward")
		return
	}
	status, err := c.Svc.Status(r.Context(), repositoryStewardProjectID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RepositoryStewardStatusResponse{RepositorySteward: status})
}

func (c *RepositoryStewardController) checkpoint(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/{projectId}/repository-steward/checkpoint")
		return
	}
	status, err := c.Svc.Checkpoint(r.Context(), repositoryStewardProjectID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RepositoryStewardStatusResponse{RepositorySteward: status})
}

func repositoryStewardProjectID(r *http.Request) domain.ProjectID {
	return domain.ProjectID(chi.URLParam(r, "projectId"))
}
