// Package controllers holds the HTTP-facing controllers for the /api/v1
// surface. Each controller groups one resource's routes, exposes a Register
// method, and depends on exactly one resource-level Manager interface — never
// directly on stores, lifecycle reducers, or adapters.
package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

const maxSetConfigBodyBytes = 1 << 20

// ProjectsController owns the /projects routes. The controller depends only on
// projectsvc.Manager; nil keeps routes registered but returns OpenAPI-backed 501s.
type ProjectsController struct {
	Mgr      projectsvc.Manager
	Capacity WorkerCapacityService
}

// WorkerCapacityService is the controller-facing contract for the worker
// capacity dashboard read model.
type WorkerCapacityService interface {
	WorkerCapacity(context.Context, domain.ProjectID) (projectsvc.WorkerCapacity, error)
}

// Register mounts the project routes on the supplied router.
func (c *ProjectsController) Register(r chi.Router) {
	r.Get("/projects", c.list)
	r.Post("/projects", c.add)
	r.Post("/projects/initialize", c.initialize)
	r.Get("/projects/{id}", c.get)
	r.Get("/projects/{id}/worker-capacity", c.workerCapacity)
	r.Put("/projects/{id}/config", c.setConfig)
	r.Post("/projects/{id}/pause", c.pause)
	r.Post("/projects/{id}/resume", c.resume)
	r.Delete("/projects/{id}", c.remove)
	// Daemon-global fleet pause switch. Grouped here because it shares the
	// project Manager; it is a distinct flag, not a fan-out over projects.
	r.Get("/fleet", c.fleetStatus)
	r.Post("/fleet/pause", c.fleetPause)
	r.Post("/fleet/resume", c.fleetResume)
}

func (c *ProjectsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects")
		return
	}
	projects, err := c.Mgr.List(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if projects == nil {
		projects = []projectsvc.Summary{}
	}
	envelope.WriteJSON(w, http.StatusOK, ListProjectsResponse{Projects: projects})
}

func (c *ProjectsController) add(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects")
		return
	}
	var in projectsvc.AddInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	p, err := c.Mgr.Add(r.Context(), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, ProjectResponse{Project: p})
}

func (c *ProjectsController) initialize(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/initialize")
		return
	}
	var in projectsvc.InitializeRepositoryInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := c.Mgr.InitializeRepository(r.Context(), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}
func (c *ProjectsController) get(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{id}")
		return
	}
	got, err := c.Mgr.Get(r.Context(), projectID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	resp, err := newGetProjectResponse(got)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "INTERNAL_ERROR", "Internal server error", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, resp)
}

func (c *ProjectsController) workerCapacity(w http.ResponseWriter, r *http.Request) {
	if c.Capacity == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{id}/worker-capacity")
		return
	}
	capacity, err := c.Capacity.WorkerCapacity(r.Context(), projectID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, WorkerCapacityResponse{Capacity: capacity})
}

func (c *ProjectsController) setConfig(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "PUT", "/api/v1/projects/{id}/config")
		return
	}
	in, err := decodeSetConfigInputStrict(w, r)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			envelope.WriteAPIError(w, r, http.StatusRequestEntityTooLarge, "request_entity_too_large", "REQUEST_BODY_TOO_LARGE", "Request body too large", nil)
			return
		}
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	p, err := c.Mgr.SetConfig(r.Context(), projectID(r), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ProjectResponse{Project: p})
}

func (c *ProjectsController) pause(w http.ResponseWriter, r *http.Request) {
	c.setPaused(w, r, true, "POST", "/api/v1/projects/{id}/pause")
}

func (c *ProjectsController) resume(w http.ResponseWriter, r *http.Request) {
	c.setPaused(w, r, false, "POST", "/api/v1/projects/{id}/resume")
}

func (c *ProjectsController) setPaused(w http.ResponseWriter, r *http.Request, paused bool, method, route string) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, method, route)
		return
	}
	p, err := c.Mgr.SetProjectPaused(r.Context(), projectID(r), paused, paused && hardParam(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ProjectResponse{Project: p})
}

// hardParam reports whether the request asked for a hard pause (immediate
// worker termination) via the boolean ?hard query parameter. It accepts the
// standard Go boolean encodings (true/1/t/T/TRUE/…) that the generated
// OpenAPI/TS boolean type implies, so a client sending ?hard=1 is honored;
// an absent or unparseable value is treated as a soft (drain) pause.
func hardParam(r *http.Request) bool {
	v, err := strconv.ParseBool(r.URL.Query().Get("hard"))
	return err == nil && v
}

func (c *ProjectsController) fleetStatus(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/fleet")
		return
	}
	paused, err := c.Mgr.FleetPaused(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, FleetStatusResponse{Paused: paused})
}

func (c *ProjectsController) fleetPause(w http.ResponseWriter, r *http.Request) {
	c.setFleetPaused(w, r, true, "/api/v1/fleet/pause")
}

func (c *ProjectsController) fleetResume(w http.ResponseWriter, r *http.Request) {
	c.setFleetPaused(w, r, false, "/api/v1/fleet/resume")
}

func (c *ProjectsController) setFleetPaused(w http.ResponseWriter, r *http.Request, paused bool, route string) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "POST", route)
		return
	}
	if err := c.Mgr.SetFleetPaused(r.Context(), paused, paused && hardParam(r)); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, FleetStatusResponse{Paused: paused})
}

func (c *ProjectsController) remove(w http.ResponseWriter, r *http.Request) {
	if c.Mgr == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/projects/{id}")
		return
	}
	result, err := c.Mgr.Remove(r.Context(), projectID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
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

// decodeJSONStrict rejects request bodies that include keys outside the target
// type. Used on project add/set-config so a misspelled or removed config field
// surfaces as a 400 instead of being silently dropped.
func decodeJSONStrict(r *http.Request, out any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}

func decodeSetConfigInputStrict(w http.ResponseWriter, r *http.Request) (projectsvc.SetConfigInput, error) {
	var in projectsvc.SetConfigInput
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSetConfigBodyBytes))
	if err != nil {
		return in, err
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return in, err
	}
	var raw struct {
		Config *struct {
			TrackerIntake *struct {
				Enabled *bool `json:"enabled"`
			} `json:"trackerIntake"`
		} `json:"config"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return in, err
	}
	if raw.Config != nil && raw.Config.TrackerIntake != nil && raw.Config.TrackerIntake.Enabled != nil {
		in.ConfigIncludesTrackerIntakeEnabled = true
	}
	return in, nil
}
