package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	suggestionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/suggestion"
)

type SuggestionService interface {
	List(ctx context.Context, projectID domain.ProjectID) ([]suggestionsvc.Suggestion, error)
	Create(ctx context.Context, projectID domain.ProjectID, in suggestionsvc.CreateInput) (suggestionsvc.Suggestion, error)
	Update(ctx context.Context, projectID domain.ProjectID, id string, in suggestionsvc.UpdateInput) (suggestionsvc.Suggestion, error)
	Start(ctx context.Context, projectID domain.ProjectID, id string) (suggestionsvc.StartResult, error)
}

type SuggestionsController struct {
	Svc SuggestionService
}

func (c *SuggestionsController) Register(r chi.Router) {
	r.Get("/projects/{projectId}/suggestions", c.list)
	r.Post("/projects/{projectId}/suggestions", c.create)
	r.Patch("/projects/{projectId}/suggestions/{suggestionId}", c.update)
	r.Post("/projects/{projectId}/suggestions/{suggestionId}/start", c.start)
}

func (c *SuggestionsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{projectId}/suggestions")
		return
	}
	items, err := c.Svc.List(r.Context(), suggestionProjectID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if items == nil {
		items = []suggestionsvc.Suggestion{}
	}
	envelope.WriteJSON(w, http.StatusOK, ListSuggestionsResponse{Suggestions: items})
}

func (c *SuggestionsController) create(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/{projectId}/suggestions")
		return
	}
	var in suggestionsvc.CreateInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	item, err := c.Svc.Create(r.Context(), suggestionProjectID(r), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, SuggestionResponse{Suggestion: item})
}

func (c *SuggestionsController) update(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PATCH", "/api/v1/projects/{projectId}/suggestions/{suggestionId}")
		return
	}
	var in suggestionsvc.UpdateInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	item, err := c.Svc.Update(r.Context(), suggestionProjectID(r), chi.URLParam(r, "suggestionId"), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SuggestionResponse{Suggestion: item})
}

func (c *SuggestionsController) start(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/projects/{projectId}/suggestions/{suggestionId}/start")
		return
	}
	result, err := c.Svc.Start(r.Context(), suggestionProjectID(r), chi.URLParam(r, "suggestionId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, StartSuggestionResponse{Suggestion: result.Suggestion, SessionID: result.SessionID})
}

func suggestionProjectID(r *http.Request) domain.ProjectID {
	return domain.ProjectID(chi.URLParam(r, "projectId"))
}
