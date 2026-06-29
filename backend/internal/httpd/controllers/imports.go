package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/legacyimport"
	importsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/importer"
)

// ImportService is the controller-facing import service contract.
type ImportService interface {
	Status(ctx context.Context) (importsvc.Status, error)
	Run(ctx context.Context) (legacyimport.Report, error)
}

// ImportController owns the /import routes.
type ImportController struct {
	Svc ImportService
}

// Register mounts import REST routes on the supplied router.
func (c *ImportController) Register(r chi.Router) {
	r.Get("/import", c.status)
	r.Post("/import", c.run)
}

func (c *ImportController) status(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/import")
		return
	}
	st, err := c.Svc.Status(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ImportStatusResponse{
		Available:  st.Available,
		LegacyRoot: st.LegacyRoot,
	})
}

func (c *ImportController) run(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/import")
		return
	}
	rep, err := c.Svc.Run(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ImportRunResponse{Report: rep})
}
