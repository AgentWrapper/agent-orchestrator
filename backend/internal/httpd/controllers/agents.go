package controllers

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/agenthealth"
)

// AgentCatalog is the controller-facing contract for local agent inventory.
type AgentCatalog interface {
	List(ctx context.Context) (agentsvc.Inventory, error)
	Refresh(ctx context.Context) (agentsvc.Inventory, error)
	Probe(ctx context.Context, agentID string) (agentsvc.ProbeResult, error)
}

// AgentHealthProvider reports the periodic per-harness health snapshot produced
// by the daemon's agent-health monitor. It is a pure in-memory read of the last
// probe cycle, so it neither blocks nor probes on the request path.
type AgentHealthProvider interface {
	Snapshot() agenthealth.Snapshot
}

// AgentsController owns the /agents routes.
type AgentsController struct {
	Catalog AgentCatalog
	Health  AgentHealthProvider
}

// Register mounts the agent inventory routes on the supplied router.
func (c *AgentsController) Register(r chi.Router) {
	r.Get("/agents", c.list)
	r.Get("/agents/health", c.health)
	r.Post("/agents/refresh", c.refresh)
	r.Post("/agents/{agent}/probe", c.probe)
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
