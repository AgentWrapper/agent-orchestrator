// Package controllers holds the HTTP-facing controllers for the /api/v1
// surface. Each controller groups one resource's routes, exposes a Register
// method that wires them on a chi.Router, and depends on exactly one
// *Manager interface from ports/inbound.go — never on a store, the LCM, an
// adapter, or any other port. Whether the Manager impl reaches past that
// boundary is its own concern.
//
// In the route-shell PR (#20) every handler is a one-line apispec.NotImplemented
// call: the contract lives in the OpenAPI document (apispec/openapi.yaml), and
// the 501 body returns that document's slice for the route so consumers can
// discover the contract from the endpoint itself. When real handlers land,
// the stub one-liner is replaced with the impl; no per-route planned
// metadata in code ever has to be deleted.
package controllers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/project"
)

// ProjectsController owns the 7 canonical /projects routes. The controller
// depends ONLY on project.Manager — it doesn't know whether the impl reaches
// into the registry, the LCM, an adapter, or all three. Mgr is nil while
// handlers are stubs; the handler-impl PR supplies a real project.Manager.
type ProjectsController struct {
	Mgr project.Manager
}

// Register mounts the project routes on the supplied router. Route order
// matters: /projects/reload must register before /projects/{id} for the POST
// verb, otherwise chi would treat "reload" as an {id} match for repair.
//
// Legacy paths that the REST audit dropped are deliberately NOT registered
// here. They surface as 405 (sibling method exists, e.g. PUT /projects/{id})
// or 404 (no sibling). The mapping lives in apispec/openapi.yaml as
// `x-replaces` on the canonical operation so consumers discover the
// migration without leaving the spec.
func (c *ProjectsController) Register(r chi.Router) {
	r.Get("/projects", c.list)
	r.Post("/projects", c.add)
	r.Post("/projects/reload", c.reload) // BEFORE /projects/{id}
	r.Get("/projects/{id}", c.get)
	r.Patch("/projects/{id}", c.updateConfig)
	r.Delete("/projects/{id}", c.remove)
	r.Post("/projects/{id}/repair", c.repair)
}

func (c *ProjectsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects")
		return
	}
	projects, err := c.Mgr.List(r.Context())
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (c *ProjectsController) add(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects")
		return
	}
	var in project.AddInput
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	p, err := c.Mgr.Add(r.Context(), in)
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, map[string]any{"project": p})
}

func (c *ProjectsController) get(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{id}")
		return
	}
	got, err := c.Mgr.Get(r.Context(), projectID(r))
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	if got.Status == "degraded" {
		envelope.WriteJSON(w, http.StatusOK, map[string]any{"status": got.Status, "project": got.Degraded})
		return
	}
	envelope.WriteJSON(w, http.StatusOK, map[string]any{"status": got.Status, "project": got.Project})
}

func (c *ProjectsController) updateConfig(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "PATCH", "/api/v1/projects/{id}")
		return
	}
	if frozen, err := containsFrozenIdentityField(r); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	} else if len(frozen) > 0 {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "IDENTITY_FROZEN", "Identity fields cannot be patched", map[string]any{"fields": frozen})
		return
	}

	var patch project.UpdateConfigInput
	if err := decodeJSON(r, &patch); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	p, err := c.Mgr.UpdateConfig(r.Context(), projectID(r), patch)
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, map[string]any{"project": p})
}

func (c *ProjectsController) remove(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/projects/{id}")
		return
	}
	result, err := c.Mgr.Remove(r.Context(), projectID(r))
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *ProjectsController) repair(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/{id}/repair")
		return
	}
	p, err := c.Mgr.Repair(r.Context(), projectID(r))
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, map[string]any{"project": p})
}

func (c *ProjectsController) reload(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/reload")
		return
	}
	result, err := c.Mgr.Reload(r.Context())
	if err != nil {
		writeProjectError(w, r, err, http.StatusInternalServerError)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func projectID(r *http.Request) domain.ProjectID {
	return domain.ProjectID(chi.URLParam(r, "id"))
}

func decodeJSON(r *http.Request, out any) error {
	return json.NewDecoder(r.Body).Decode(out)
}

func containsFrozenIdentityField(r *http.Request) ([]string, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	var frozen []string
	for _, field := range []string{"projectId", "path", "repo", "defaultBranch"} {
		if _, ok := raw[field]; ok {
			frozen = append(frozen, field)
		}
	}
	return frozen, nil
}

func writeProjectError(w http.ResponseWriter, r *http.Request, err error, fallbackStatus int) {
	var pe *project.Error
	if errors.As(err, &pe) {
		status := fallbackStatus
		switch pe.Kind {
		case "bad_request":
			status = http.StatusBadRequest
		case "not_found":
			status = http.StatusNotFound
		case "conflict":
			status = http.StatusConflict
		case "not_implemented":
			status = http.StatusNotImplemented
		case "internal":
			status = http.StatusInternalServerError
		}
		envelope.WriteAPIError(w, r, status, pe.Kind, pe.Code, pe.Message, pe.Details)
		return
	}
	envelope.WriteAPIError(w, r, fallbackStatus, "internal", "INTERNAL_ERROR", "Internal server error", nil)
}
