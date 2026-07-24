package controllers

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

var browserActions = map[string]struct{}{
	"open":           {},
	"snapshot":       {},
	"click":          {},
	"fill":           {},
	"type":           {},
	"press":          {},
	"hover":          {},
	"highlight":      {},
	"unhighlight":    {},
	"tabs":           {},
	"tab-new":        {},
	"tab-select":     {},
	"tab-close":      {},
	"scroll":         {},
	"select":         {},
	"check":          {},
	"uncheck":        {},
	"get":            {},
	"wait":           {},
	"screenshot":     {},
	"network-start":  {},
	"network-status": {},
	"network-list":   {},
	"network-stop":   {},
	"network-clear":  {},
	"console":        {},
	"errors":         {},
}

type BrowserRuntime interface {
	Status() browserruntime.Status
	Execute(ctx context.Context, sessionID domain.SessionID, action string, args map[string]interface{}) (browserruntime.Result, error)
}

type BrowserSessionReader interface {
	Get(ctx context.Context, id domain.SessionID) (domain.Session, error)
}

type BrowserController struct {
	Runtime  BrowserRuntime
	Sessions BrowserSessionReader
}

func (c *BrowserController) Register(r chi.Router) {
	r.Get("/browser/status", c.status)
	r.Post("/browser/commands", c.execute)
}

func (c *BrowserController) status(w http.ResponseWriter, r *http.Request) {
	if c.Runtime == nil || c.Sessions == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/browser/status")
		return
	}
	sessionID := domain.SessionID(strings.TrimSpace(r.URL.Query().Get("sessionId")))
	if sessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SESSION_ID_REQUIRED", "sessionId is required", nil)
		return
	}
	if _, err := c.Sessions.Get(r.Context(), sessionID); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	status := c.Runtime.Status()
	envelope.WriteJSON(w, http.StatusOK, BrowserStatusResponse{
		SessionID:   sessionID,
		Connected:   status.Connected,
		ConnectedAt: status.ConnectedAt,
		Transport:   "electron-webcontents-debugger",
	})
}

func (c *BrowserController) execute(w http.ResponseWriter, r *http.Request) {
	if c.Runtime == nil || c.Sessions == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/browser/commands")
		return
	}
	var in BrowserCommandRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	in.Action = strings.ToLower(strings.TrimSpace(in.Action))
	if in.SessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SESSION_ID_REQUIRED", "sessionId is required", nil)
		return
	}
	if _, ok := browserActions[in.Action]; !ok {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "BROWSER_ACTION_UNSUPPORTED", "Unsupported browser action", nil)
		return
	}
	if _, err := c.Sessions.Get(r.Context(), in.SessionID); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	result, err := c.Runtime.Execute(r.Context(), in.SessionID, in.Action, in.Args)
	if err != nil {
		writeBrowserError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, BrowserCommandResponse{
		RequestID: result.RequestID,
		SessionID: in.SessionID,
		Action:    in.Action,
		Result:    result.Value,
	})
}

func writeBrowserError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, browserruntime.ErrUnavailable) {
		envelope.WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "BROWSER_RUNTIME_UNAVAILABLE", "Desktop browser runtime is not connected", nil)
		return
	}
	var commandErr browserruntime.CommandError
	if errors.As(err, &commandErr) {
		status := http.StatusUnprocessableEntity
		typeName := "unprocessable"
		switch commandErr.Code {
		case "INVALID_ARGUMENT", "URL_REQUIRED", "REFERENCE_REQUIRED", "TAB_ID_REQUIRED":
			status = http.StatusBadRequest
			typeName = "bad_request"
		case "STALE_REFERENCE", "TAB_NOT_FOUND":
			status = http.StatusConflict
			typeName = "conflict"
		case "BROWSER_TARGET_UNAVAILABLE":
			status = http.StatusServiceUnavailable
			typeName = "unavailable"
		}
		envelope.WriteAPIError(w, r, status, typeName, commandErr.Code, commandErr.Message, nil)
		return
	}
	envelope.WriteError(w, r, err)
}
