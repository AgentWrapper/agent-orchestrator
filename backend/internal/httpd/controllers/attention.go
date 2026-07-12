package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	attentionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/attention"
)

// OperatorAttentionService is the canonical operator-attention projection owner
// (backend/internal/service/attention). The controller is a thin HTTP adapter
// over it: it renders the transport-neutral projection into the wire DTO and
// owns no derivation logic of its own (issue #268 Phase 1).
type OperatorAttentionService interface {
	ListOperator(ctx context.Context) ([]attentionsvc.Item, error)
}

// AttentionController owns canonical attention routes.
type AttentionController struct {
	Svc OperatorAttentionService
}

// Register mounts attention routes on the supplied router.
func (c *AttentionController) Register(r chi.Router) {
	r.Get("/attention/operator", c.listOperator)
}

func (c *AttentionController) listOperator(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/attention/operator")
		return
	}
	items, err := c.Svc.ListOperator(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListOperatorAttentionResponse{Items: operatorAttentionItemsToDTO(items)})
}

// operatorAttentionItemsToDTO maps the transport-neutral projection to the wire
// DTO. The DTO stays in the controllers package so the reflected OpenAPI schema
// (ControllersOperatorAttentionItem → OperatorAttentionItem) is unchanged.
func operatorAttentionItemsToDTO(items []attentionsvc.Item) []OperatorAttentionItem {
	out := make([]OperatorAttentionItem, 0, len(items))
	for _, it := range items {
		out = append(out, OperatorAttentionItem{
			ID:           it.ID,
			Kind:         it.Kind,
			ProjectID:    it.ProjectID,
			SessionID:    it.SessionID,
			SessionTitle: it.SessionTitle,
			Reason:       it.Reason,
			Action:       it.Action,
			DeepLink:     it.DeepLink,
			UpdatedAt:    it.UpdatedAt,
			DecisionKind: it.DecisionKind,
			Question:     it.Question,
			PRNumber:     it.PRNumber,
			PRURL:        it.PRURL,
			PRTitle:      it.PRTitle,
		})
	}
	return out
}
