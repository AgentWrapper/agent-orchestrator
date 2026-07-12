package controllers

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentconfig"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/agenthealth"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

// AgentCatalog is the controller-facing contract for local agent inventory.
type AgentCatalog interface {
	List(ctx context.Context) (agentsvc.Inventory, error)
	Refresh(ctx context.Context) (agentsvc.Inventory, error)
	Probe(ctx context.Context, agentID string) (agentsvc.ProbeResult, error)
	ModelAvailability(ctx context.Context, req agentsvc.ModelAvailabilityRequest) (agentsvc.ModelAvailabilityResponse, error)
}

// AgentHealthProvider reports the periodic per-harness health snapshot produced
// by the daemon's agent-health monitor. It is a pure in-memory read of the last
// probe cycle, so it neither blocks nor probes on the request path.
type AgentHealthProvider interface {
	Snapshot() agenthealth.Snapshot
}

// AgentModelPinProvider is the project-read surface needed to include stored
// model pins in model availability output.
type AgentModelPinProvider interface {
	List(ctx context.Context) ([]projectsvc.Summary, error)
	Get(ctx context.Context, id domain.ProjectID) (projectsvc.GetResult, error)
}

// AgentsController owns the /agents routes.
type AgentsController struct {
	Catalog   AgentCatalog
	Health    AgentHealthProvider
	ModelPins AgentModelPinProvider
}

// Register mounts the agent inventory routes on the supplied router.
func (c *AgentsController) Register(r chi.Router) {
	r.Get("/agents", c.list)
	r.Get("/agents/health", c.health)
	r.Get("/agents/models", c.models)
	r.Post("/agents/refresh", c.refresh)
	r.Post("/agents/{agent}/probe", c.probe)
}

func (c *AgentsController) models(w http.ResponseWriter, r *http.Request) {
	if c.Catalog == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/models")
		return
	}
	models, err := c.Catalog.ModelAvailability(r.Context(), agentsvc.ModelAvailabilityRequest{
		Force: queryBool(r, "force"),
		Pins:  c.configuredModelPins(r.Context()),
	})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, models)
}

func queryBool(r *http.Request, name string) bool {
	v := strings.TrimSpace(r.URL.Query().Get(name))
	return strings.EqualFold(v, "true") || v == "1"
}

func (c *AgentsController) configuredModelPins(ctx context.Context) []agentsvc.ModelPin {
	if c.ModelPins == nil {
		return nil
	}
	summaries, err := c.ModelPins.List(ctx)
	if err != nil {
		return nil
	}
	var pins []agentsvc.ModelPin
	for _, summary := range summaries {
		res, err := c.ModelPins.Get(ctx, summary.ID)
		if err != nil || res.Project == nil || res.Project.Config == nil {
			continue
		}
		pins = append(pins, pinsFromConfig(res.Project.Config.WithDefaults())...)
	}
	return pins
}

func pinsFromConfig(cfg domain.ProjectConfig) []agentsvc.ModelPin {
	resolved := agentconfig.ConfiguredModelPins(cfg)
	pins := make([]agentsvc.ModelPin, 0, len(resolved))
	for _, pin := range resolved {
		pins = append(pins, agentsvc.ModelPin{Harness: pin.Harness, Model: pin.Model})
	}
	return pins
}

func (c *AgentsController) health(w http.ResponseWriter, r *http.Request) {
	if c.Health == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/health")
		return
	}
	envelope.WriteJSON(w, http.StatusOK, c.Health.Snapshot())
}

func (c *AgentsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Catalog == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents")
		return
	}
	inventory, err := c.Catalog.List(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, inventory)
}

func (c *AgentsController) refresh(w http.ResponseWriter, r *http.Request) {
	if c.Catalog == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/refresh")
		return
	}
	inventory, err := c.Catalog.Refresh(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, inventory)
}

func (c *AgentsController) probe(w http.ResponseWriter, r *http.Request) {
	if c.Catalog == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/{agent}/probe")
		return
	}
	agentID := strings.TrimSpace(chi.URLParam(r, "agent"))
	if agentID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "AGENT_REQUIRED", "agent is required", nil)
		return
	}
	result, err := c.Catalog.Probe(r.Context(), agentID)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}
