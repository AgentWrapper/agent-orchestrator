package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// AgentCatalog is the controller-facing contract for local agent inventory.
type AgentCatalog interface {
	List(ctx context.Context) (agentsvc.Inventory, error)
	Refresh(ctx context.Context) (agentsvc.Inventory, error)
}

// AgentsController owns the /agents routes.
type AgentsController struct {
	Catalog AgentCatalog
}

// Register mounts the agent inventory routes on the supplied router.
func (c *AgentsController) Register(r chi.Router) {
	r.Get("/agents", c.list)
	r.Post("/agents/refresh", c.refresh)
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
