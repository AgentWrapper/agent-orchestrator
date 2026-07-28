package controllers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// CloudService is the subset of the cloud supervisor the API layer needs. The
// concrete implementation lives in internal/cloud; this interface keeps the
// controller testable.
type CloudService interface {
	Capabilities() (configured bool, harnesses []string)
	SpawnCloud(ctx context.Context, in cloud.SpawnInput) (*cloud.SpawnResult, error)
	ListSessions() []cloud.CloudSession
	SessionStatus(ctx context.Context, sandboxID string) (json.RawMessage, error)
	ViewURL(ctx context.Context, sandboxID string) (string, error)
	Share(ctx context.Context, sandboxID string, ttlSec int, projectName string) (*cloud.ShareResult, error)
	ProxyFetch(ctx context.Context, previewURL, method, path string, body any) (int, json.RawMessage, error)
	Terminate(ctx context.Context, sandboxID string) error
	Restore(ctx context.Context)
}

// CloudController exposes the per-session cloud-sandbox surface: spawn a worker
// in a remote sandbox, list/inspect them, mint a signed view URL, share a
// read-only token, proxy REST to a sandbox, and tear one down. A cloud session
// is otherwise an ordinary session — its state/terminal come from the sandbox's
// own daemon over the preview URL.
type CloudController struct {
	Svc CloudService
}

// ── DTOs ────────────────────────────────────────────────────────────────────

// CloudSandboxIDParam is the {sandboxId} path parameter for cloud routes.
type CloudSandboxIDParam struct {
	SandboxID string `path:"sandboxId" description:"Cloud sandbox identifier."`
}

// CloudCapabilitiesResponse reports whether cloud is usable and which harnesses.
type CloudCapabilitiesResponse struct {
	Configured bool     `json:"configured"`
	Harnesses  []string `json:"harnesses"`
}

// CloudSpawnRequest starts one session in a fresh cloud sandbox. Kind is
// "worker" (default) or "orchestrator".
type CloudSpawnRequest struct {
	Harness        string `json:"harness"`
	LocalProjectID string `json:"localProjectId"`
	ProjectPath    string `json:"projectPath"`
	// RemoteURL: git origin to clone into the sandbox. Required when spawning via
	// the control plane (it can't read the local ProjectPath); the client sends
	// project.repo. Empty on the local daemon → derived from ProjectPath.
	RemoteURL   string `json:"remoteUrl,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Branch      string `json:"branch,omitempty"`
	Kind        string `json:"kind,omitempty"`
	// Credential is the harness credential supplied at spawn time (the desktop
	// app reads the user's current Claude credential and sends it). Injected into
	// the sandbox and discarded — never stored or logged.
	Credential string `json:"credential,omitempty"`
}

// CloudSpawnResponse acknowledges a spawn. Provisioning is async: the sandbox is
// created (status "provisioning") and the session goes live shortly after.
type CloudSpawnResponse struct {
	SandboxID string `json:"sandboxId"`
	Status    string `json:"status"`
}

// CloudSessionView is one cloud session in the registry. During async
// provisioning Status is "provisioning" and SessionID/PreviewURL are empty;
// once "ready" they are populated. "failed" carries an Error.
type CloudSessionView struct {
	SessionID      string `json:"sessionId"`
	LocalProjectID string `json:"localProjectId"`
	ProjectID      string `json:"projectId"`
	Harness        string `json:"harness"`
	SandboxID      string `json:"sandboxId"`
	PreviewURL     string `json:"previewUrl"`
	Status         string `json:"status"`
	Error          string `json:"error,omitempty"`
	DisplayName    string `json:"displayName,omitempty"`
}

// CloudSessionsResponse lists the live cloud sessions.
type CloudSessionsResponse struct {
	Sessions []CloudSessionView `json:"sessions"`
}

// CloudViewURLResponse is a fresh signed preview URL for a sandbox.
type CloudViewURLResponse struct {
	URL string `json:"url"`
}

// CloudShareRequest mints a readonly share token. Both fields are optional.
type CloudShareRequest struct {
	ProjectName string `json:"projectName,omitempty"`
	TTLSec      int    `json:"ttlSec,omitempty"`
}

// CloudShareResponse is the encoded token plus its lifetime.
type CloudShareResponse struct {
	Token        string `json:"token"`
	ExpiresInSec int    `json:"expiresInSec"`
}

// CloudTerminateResponse acknowledges a torn-down sandbox.
type CloudTerminateResponse struct {
	Terminated bool `json:"terminated"`
}

// CloudProxyRequest asks the backend to relay a REST call to a sandbox. Body is
// arbitrary JSON forwarded verbatim.
type CloudProxyRequest struct {
	PreviewURL string `json:"previewUrl"`
	Method     string `json:"method,omitempty"`
	Path       string `json:"path"`
	Body       any    `json:"body,omitempty"`
}

// CloudProxyResponse carries the relayed status + body (arbitrary JSON).
type CloudProxyResponse struct {
	OK     bool `json:"ok"`
	Status int  `json:"status"`
	JSON   any  `json:"json,omitempty"`
}

// ── routes ──────────────────────────────────────────────────────────────────

// Register mounts the cloud routes.
func (c *CloudController) Register(r chi.Router) {
	r.Get("/cloud/capabilities", c.capabilities)
	r.Post("/cloud/sessions", c.spawn)
	r.Get("/cloud/sessions", c.list)
	r.Get("/cloud/sessions/{sandboxId}/status", c.status)
	r.Get("/cloud/sessions/{sandboxId}/view-url", c.viewURL)
	r.Post("/cloud/sessions/{sandboxId}/share", c.share)
	r.Delete("/cloud/sessions/{sandboxId}", c.terminate)
	r.Post("/cloud/proxy", c.proxy)
	r.Post("/cloud/shared-proxy", c.sharedProxy)
}

func (c *CloudController) capabilities(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		// Cloud not wired (no key / feature off) → report not-configured, not 501,
		// so a client simply hides the Local/Cloud toggle.
		envelope.WriteJSON(w, http.StatusOK, CloudCapabilitiesResponse{Configured: false, Harnesses: []string{}})
		return
	}
	configured, harnesses := c.Svc.Capabilities()
	if harnesses == nil {
		harnesses = []string{}
	}
	envelope.WriteJSON(w, http.StatusOK, CloudCapabilitiesResponse{Configured: configured, Harnesses: harnesses})
}

func (c *CloudController) spawn(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/cloud/sessions")
		return
	}
	var in CloudSpawnRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.Harness == "" || in.LocalProjectID == "" || in.ProjectPath == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "MISSING_FIELD",
			"harness, localProjectId and projectPath are required", nil)
		return
	}
	res, err := c.Svc.SpawnCloud(r.Context(), cloud.SpawnInput{
		Harness:        in.Harness,
		LocalProjectID: in.LocalProjectID,
		ProjectPath:    in.ProjectPath,
		RemoteURL:      in.RemoteURL,
		Prompt:         in.Prompt,
		DisplayName:    in.DisplayName,
		Branch:         in.Branch,
		Kind:           in.Kind,
		Credential:     in.Credential,
	})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, CloudSpawnResponse{SandboxID: res.SandboxID, Status: res.Status})
}

func (c *CloudController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		envelope.WriteJSON(w, http.StatusOK, CloudSessionsResponse{Sessions: []CloudSessionView{}})
		return
	}
	// Re-attach sandboxes that survived a restart before the first listing.
	c.Svc.Restore(r.Context())
	sessions := c.Svc.ListSessions()
	views := make([]CloudSessionView, 0, len(sessions))
	for _, s := range sessions {
		views = append(views, CloudSessionView{
			SessionID: s.SessionID, LocalProjectID: s.LocalProjectID, ProjectID: s.ProjectID,
			Harness: s.Harness, SandboxID: s.SandboxID, PreviewURL: s.PreviewURL,
			Status: s.Status, Error: s.Error, DisplayName: s.DisplayName,
		})
	}
	envelope.WriteJSON(w, http.StatusOK, CloudSessionsResponse{Sessions: views})
}

func (c *CloudController) status(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/cloud/sessions/{sandboxId}/status")
		return
	}
	raw, err := c.Svc.SessionStatus(r.Context(), chi.URLParam(r, "sandboxId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if len(raw) == 0 {
		envelope.WriteJSON(w, http.StatusOK, SessionResponse{})
		return
	}
	// raw is the sandbox daemon's own SessionResponse JSON — pass it through verbatim.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func (c *CloudController) viewURL(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/cloud/sessions/{sandboxId}/view-url")
		return
	}
	url, err := c.Svc.ViewURL(r.Context(), chi.URLParam(r, "sandboxId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, CloudViewURLResponse{URL: url})
}

func (c *CloudController) share(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/cloud/sessions/{sandboxId}/share")
		return
	}
	var in CloudShareRequest
	_ = decodeJSON(r, &in) // body optional (defaults: readonly, 24h)
	res, err := c.Svc.Share(r.Context(), chi.URLParam(r, "sandboxId"), in.TTLSec, in.ProjectName)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if res == nil {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "SESSION_NOT_FOUND",
			"no cloud session for that sandbox", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, CloudShareResponse{Token: res.Token, ExpiresInSec: res.ExpiresInSec})
}

func (c *CloudController) terminate(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/cloud/sessions/{sandboxId}")
		return
	}
	if err := c.Svc.Terminate(r.Context(), chi.URLParam(r, "sandboxId")); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, CloudTerminateResponse{Terminated: true})
}

// proxy performs a REST call to a sandbox preview URL from the backend, so a
// signed preview URL never leaves the server and no cross-origin rules apply.
func (c *CloudController) proxy(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/cloud/proxy")
		return
	}
	var in CloudProxyRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.PreviewURL == "" || in.Path == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "MISSING_FIELD",
			"previewUrl and path are required", nil)
		return
	}
	method := in.Method
	if method == "" {
		method = http.MethodGet
	}
	status, raw, err := c.Svc.ProxyFetch(r.Context(), in.PreviewURL, method, in.Path, in.Body)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	var jsonField any
	if len(raw) > 0 {
		jsonField = json.RawMessage(raw)
	}
	envelope.WriteJSON(w, http.StatusOK, CloudProxyResponse{
		OK: status >= 200 && status < 300, Status: status, JSON: jsonField,
	})
}

// sharedProxy is the read-only relay for shared-session viewers. It mirrors
// proxy but forbids non-GET methods. On the hosted control plane the equivalent
// route skips the tenant-ownership check so a readonly `ao://share/...` link is
// viewable by anyone holding it; ProxyFetch still refuses non-sandbox URLs.
func (c *CloudController) sharedProxy(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/cloud/shared-proxy")
		return
	}
	var in CloudProxyRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.PreviewURL == "" || in.Path == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "MISSING_FIELD",
			"previewUrl and path are required", nil)
		return
	}
	method := in.Method
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet {
		envelope.WriteAPIError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "READ_ONLY",
			"shared sessions are read-only", nil)
		return
	}
	status, raw, err := c.Svc.ProxyFetch(r.Context(), in.PreviewURL, method, in.Path, nil)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	var jsonField any
	if len(raw) > 0 {
		jsonField = json.RawMessage(raw)
	}
	envelope.WriteJSON(w, http.StatusOK, CloudProxyResponse{
		OK: status >= 200 && status < 300, Status: status, JSON: jsonField,
	})
}
