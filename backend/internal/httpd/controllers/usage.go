package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// UsageSummaryService is the controller-facing compact usage read contract.
type UsageSummaryService interface {
	ListCompact(context.Context, domain.ProjectID) ([]domain.CompactSessionUsage, error)
}

// UsageController owns compact dashboard usage routes.
type UsageController struct {
	Svc UsageSummaryService
}

// Register mounts usage routes on the supplied router.
func (c *UsageController) Register(r chi.Router) {
	r.Get("/usage/sessions", c.listSessions)
}

func (c *UsageController) listSessions(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/usage/sessions")
		return
	}
	items, err := c.Svc.ListCompact(r.Context(), domain.ProjectID(r.URL.Query().Get("projectId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	out := make([]CompactSessionUsageResponse, 0, len(items))
	for _, item := range items {
		out = append(out, CompactSessionUsageResponse{
			SessionID:       item.SessionID,
			TotalTokens:     item.TotalTokens,
			CollectionState: string(item.CollectionState),
			Coverage:        string(item.Coverage),
			LastObservedAt:  item.LastObservedAt,
		})
	}
	envelope.WriteJSON(w, http.StatusOK, ListCompactSessionUsageResponse{Sessions: out})
}
