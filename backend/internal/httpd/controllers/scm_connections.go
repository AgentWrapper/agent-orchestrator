package controllers

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	scmconnectionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

// SCMConnectionsController owns the global /scm/connections routes.
type SCMConnectionsController struct {
	Svc scmconnectionsvc.Manager
}

// Register mounts the global SCM connection routes.
func (c *SCMConnectionsController) Register(r chi.Router) {
	r.Get("/scm/connections", c.list)
	r.Post("/scm/connections", c.create)
	r.Get("/scm/connections/{id}", c.get)
	r.Put("/scm/connections/{id}", c.update)
	r.Delete("/scm/connections/{id}", c.delete)
	r.Post("/scm/connections/{id}/test", c.test)
}

func (c *SCMConnectionsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/scm/connections")
		return
	}
	connections, err := c.Svc.List(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if connections == nil {
		connections = []scmconnectionsvc.Connection{}
	}
	envelope.WriteJSON(w, http.StatusOK, ListSCMConnectionsResponse{Connections: connections})
}

func (c *SCMConnectionsController) create(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/scm/connections")
		return
	}
	var in scmconnectionsvc.CreateInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	connection, err := c.Svc.Create(r.Context(), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, SCMConnectionResponse{Connection: connection})
}

func (c *SCMConnectionsController) get(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/scm/connections/{id}")
		return
	}
	connection, err := c.Svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SCMConnectionResponse{Connection: connection})
}

func (c *SCMConnectionsController) update(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPut, "/api/v1/scm/connections/{id}")
		return
	}
	var in scmconnectionsvc.UpdateInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	connection, err := c.Svc.Update(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SCMConnectionResponse{Connection: connection})
}

func (c *SCMConnectionsController) delete(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodDelete, "/api/v1/scm/connections/{id}")
		return
	}
	if err := c.Svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (c *SCMConnectionsController) test(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/scm/connections/{id}/test")
		return
	}
	var in scmconnectionsvc.TestInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if strings.TrimSpace(in.Repository) == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SCM_REPOSITORY_REQUIRED", "SCM repository is required", nil)
		return
	}
	result, err := c.Svc.Test(r.Context(), chi.URLParam(r, "id"), in.Repository)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SCMConnectionTestResponse{Result: result})
}
