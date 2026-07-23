package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	shelltermsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

// ShellTerminalService is the controller-facing standalone shell terminal
// contract.
type ShellTerminalService interface {
	OpenShellTerminal(ctx context.Context, in shelltermsvc.OpenShellTerminalInput) (shelltermsvc.ShellTerminal, error)
	ListShellTerminalsForCurrentAppRun(ctx context.Context) ([]shelltermsvc.ShellTerminal, error)
	CloseShellTerminal(ctx context.Context, handleID string) error
}

// ShellTerminalsController owns the /shell-terminals routes: standalone shells
// the user opens by hand, independent of any agent session.
type ShellTerminalsController struct {
	Svc ShellTerminalService
}

// Register mounts the bounded shell terminal REST routes.
func (c *ShellTerminalsController) Register(r chi.Router) {
	r.Get("/shell-terminals", c.list)
	r.Post("/shell-terminals", c.open)
	r.Delete("/shell-terminals/{handleId}", c.close)
}

func (c *ShellTerminalsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/shell-terminals")
		return
	}
	terminals, err := c.Svc.ListShellTerminalsForCurrentAppRun(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListShellTerminalsResponse{
		ShellTerminals: shellTerminalResponses(terminals),
	})
}

func (c *ShellTerminalsController) open(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/shell-terminals")
		return
	}
	// An empty body is a valid request: it means "open a shell with no project
	// context", which the service resolves to the daemon data dir.
	var req OpenShellTerminalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	terminal, err := c.Svc.OpenShellTerminal(r.Context(), shelltermsvc.OpenShellTerminalInput{
		ProjectID: domain.ProjectID(req.ProjectID),
	})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, ShellTerminalEnvelope{
		ShellTerminal: shellTerminalResponse(terminal),
	})
}

func (c *ShellTerminalsController) close(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/shell-terminals/{handleId}")
		return
	}
	if err := c.Svc.CloseShellTerminal(r.Context(), chi.URLParam(r, "handleId")); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func shellTerminalResponses(in []shelltermsvc.ShellTerminal) []ShellTerminalResponse {
	out := make([]ShellTerminalResponse, 0, len(in))
	for _, t := range in {
		out = append(out, shellTerminalResponse(t))
	}
	return out
}

func shellTerminalResponse(t shelltermsvc.ShellTerminal) ShellTerminalResponse {
	return ShellTerminalResponse{
		HandleID:   t.HandleID,
		ProjectID:  string(t.ProjectID),
		WorkingDir: t.WorkingDir,
		Title:      t.Title,
		CreatedAt:  t.CreatedAt,
	}
}
