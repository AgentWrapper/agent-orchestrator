package controlplane

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud"
)

// Server is the hosted control plane. It owns one cloud.Supervisor (single
// Daytona key, tenant-scoped registry) and exposes a tenant-authenticated cloud
// API mirroring the daemon's /api/v1/cloud/* surface — every call scoped to the
// caller's tenant.
type Server struct {
	sup  *cloud.Supervisor
	auth Authenticator
	log  *slog.Logger
	// locations is the federated-bus session directory (Phase B). Populated by
	// the daemon channel (Turn 2) + cloud spawns, consulted by the router (Turn 3)
	// to relay send/spawn/kill/events to whichever host owns a session.
	locations LocationRegistry
	// hub is the federated-bus router (Phase B): it owns the daemon channels and
	// routes commands/events across locations via locations + the sandbox relay.
	hub *Hub
	// busSigner verifies per-sandbox bus tokens on the bus endpoints (nil when no
	// signing key is configured; sandboxes then get no outbound channel).
	busSigner *BusTokenSigner
}

// NewServer wires the control plane. sup must be built with a tenant-scoped
// Store (SQLStore) and the single Daytona key. busSigner may be nil (bus tokens
// disabled).
func NewServer(sup *cloud.Supervisor, auth Authenticator, busSigner *BusTokenSigner, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	locations := NewInMemoryLocationRegistry()
	srv := &Server{
		sup:       sup,
		auth:      auth,
		log:       log,
		locations: locations,
		hub:       NewHub(locations, newSupervisorRelay(sup), log),
		busSigner: busSigner,
	}
	// Keep the federated-bus location registry in sync with cloud sessions: a
	// ready sandbox session is reachable inbound via its preview URL, so file it
	// as LocationSandbox; drop it on teardown.
	sup.SetLocationHooks(
		func(cs cloud.CloudSession) {
			// Route by the globally-unique sandboxId; keep the in-sandbox session
			// id for the relay URL. (In-sandbox ids collide across sandboxes.)
			locations.Register(SessionLocation{
				SessionID:          cs.SandboxID,
				TenantID:           cs.TenantID,
				ProjectID:          cs.LocalProjectID,
				Kind:               cs.Kind,
				Type:               LocationSandbox,
				SandboxID:          cs.SandboxID,
				InSandboxSessionID: cs.SessionID,
				OrchestratorID:     cs.OrchestratorID,
				PreviewURL:         cs.PreviewURL,
			})
		},
		func(cs cloud.CloudSession) {
			locations.Remove(cs.TenantID, cs.SandboxID)
		},
	)
	return srv
}

// Handler builds the router: health (open) + tenant-authed /api/v1/cloud/*.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	r.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ready"})
	})

	r.Group(func(r chi.Router) {
		r.Use(authMiddleware(s.auth))
		r.Get("/api/v1/cloud/capabilities", s.capabilities)
		r.Post("/api/v1/cloud/sessions", s.spawn)
		r.Get("/api/v1/cloud/sessions", s.list)
		r.Get("/api/v1/cloud/sessions/{sandboxId}/status", s.status)
		r.Get("/api/v1/cloud/sessions/{sandboxId}/view-url", s.viewURL)
		r.Post("/api/v1/cloud/sessions/{sandboxId}/share", s.share)
		r.Delete("/api/v1/cloud/sessions/{sandboxId}", s.terminate)
		r.Post("/api/v1/cloud/proxy", s.proxy)
		// A laptop daemon mints a longer-lived, tenant-scoped bus token here (with
		// its real user JWT) so it can join the bus without re-sending the
		// short-lived Clerk token on every frame. (Task 1: laptop-in-loop.)
		r.Post("/api/v1/cloud/bus/token", s.busToken)
	})

	// Federated bus (Phase B): the daemon channel + routing endpoints. These
	// accept a full user token (a laptop daemon) OR a per-sandbox bus token (an
	// in-sandbox daemon) — but never let a bus token reach spawn/terminate above.
	r.Group(func(r chi.Router) {
		r.Use(busAuthMiddleware(s.auth, s.busSigner))
		r.Get("/api/v1/cloud/bus/stream", s.busStream)        // CP → daemon (SSE push)
		r.Post("/api/v1/cloud/bus/register", s.busRegister)   // daemon → CP: own these sessions
		r.Post("/api/v1/cloud/bus/route", s.busRoute)         // daemon → CP: route a command
		r.Post("/api/v1/cloud/bus/event", s.busEvent)         // daemon → CP: deliver an event
		r.Post("/api/v1/cloud/bus/provision", s.busProvision) // daemon → CP: provision a new sandbox
		// Fleet view — bus-authed so an in-sandbox orchestrator (which holds only a
		// bus token) can discover the workers it owns across locations. (Task 3.)
		r.Get("/api/v1/cloud/bus/locations", s.busLocations)
	})
	return withCORS(r)
}

// withCORS lets the browser renderer reach the control plane cross-origin
// (http://localhost:5173 in dev, app://renderer when packaged). Auth is
// Bearer-only with no cookies, so reflecting the request Origin without
// credentials is safe. The preflight OPTIONS is answered here — outside the auth
// group — so it isn't rejected for lacking a token.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	configured, harnesses := s.sup.Capabilities()
	if harnesses == nil {
		harnesses = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": configured, "harnesses": harnesses})
}

type spawnRequest struct {
	Harness        string `json:"harness"`
	LocalProjectID string `json:"localProjectId"`
	ProjectPath    string `json:"projectPath"`
	// RemoteURL is REQUIRED for a non-empty clone: the control plane can't read
	// the caller's local ProjectPath to derive the git remote. Clients send the
	// project's origin (e.g. project.repo).
	RemoteURL   string `json:"remoteUrl,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Branch      string `json:"branch,omitempty"`
	Kind        string `json:"kind,omitempty"`
	// Credential is the harness credential the client supplies at spawn time
	// (e.g. the desktop app's current Claude credential). Injected into the
	// sandbox and discarded — never stored or logged by the control plane.
	Credential string `json:"credential,omitempty"`
	// OrchestratorID is set on a delegated spawn (an orchestrator provisioning a
	// worker): the worker's sandbox reports idle back to this session over the bus.
	OrchestratorID string `json:"orchestratorId,omitempty"`
	// IdempotencyKey dedupes retried delegated spawns (see cloud.SpawnInput).
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}

func (s *Server) spawn(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	var in spawnRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if in.Harness == "" || in.LocalProjectID == "" || in.ProjectPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "harness, localProjectId and projectPath are required"})
		return
	}
	res, err := s.sup.SpawnCloud(r.Context(), cloud.SpawnInput{
		Harness:        in.Harness,
		LocalProjectID: in.LocalProjectID,
		ProjectPath:    in.ProjectPath,
		RemoteURL:      in.RemoteURL,
		Prompt:         in.Prompt,
		DisplayName:    in.DisplayName,
		Branch:         in.Branch,
		Kind:           in.Kind,
		TenantID:       tenant,
		Credential:     in.Credential,
	})
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// busProvision lets a bus-authed caller (an in-sandbox orchestrator, or a laptop
// daemon) provision a NEW sandbox for its tenant. It's the delegation path for
// `ao spawn --cloud` from inside a keyless sandbox: the sandbox can't reach the
// cloud provider, so it asks the control plane to do it. Bus-authed (a scoped
// bus token works), tenant-scoped, and it accepts a spawn-time credential so the
// orchestrator's credential propagates to the new worker. (Task 2.)
func (s *Server) busProvision(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	var in spawnRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if in.Harness == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "harness is required"})
		return
	}
	res, err := s.sup.SpawnCloud(r.Context(), cloud.SpawnInput{
		Harness:        in.Harness,
		LocalProjectID: in.LocalProjectID,
		ProjectPath:    in.ProjectPath,
		RemoteURL:      in.RemoteURL,
		Prompt:         in.Prompt,
		DisplayName:    in.DisplayName,
		Branch:         in.Branch,
		Kind:           in.Kind,
		TenantID:       tenant,
		Credential:     in.Credential,
		OrchestratorID: in.OrchestratorID,
		IdempotencyKey: in.IdempotencyKey,
	})
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	s.sup.Restore(r.Context())
	sessions := s.sup.ListSessionsForTenant(tenant)
	if sessions == nil {
		sessions = []cloud.CloudSession{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// guard returns true (and 404s) if the tenant does not own the sandbox — so a
// tenant can never touch another tenant's sandbox.
func (s *Server) guard(w http.ResponseWriter, r *http.Request) (sandboxID string, ok bool) {
	sandboxID = chi.URLParam(r, "sandboxId")
	// Rehydrate this replica's in-memory session map from the shared registry
	// before the ownership check — otherwise a sandbox spawned on another replica
	// (or before a restart) is invisible here and mutating ops 404 while the
	// sandbox keeps running. Restore is once-per-process, so this is a cheap no-op
	// after the first call.
	s.sup.Restore(r.Context())
	if !s.sup.OwnsSandbox(TenantFromContext(r.Context()), sandboxID) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
		return "", false
	}
	return sandboxID, true
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	sandboxID, ok := s.guard(w, r)
	if !ok {
		return
	}
	raw, err := s.sup.SessionStatus(r.Context(), sandboxID)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	if len(raw) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"session": nil})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func (s *Server) viewURL(w http.ResponseWriter, r *http.Request) {
	sandboxID, ok := s.guard(w, r)
	if !ok {
		return
	}
	url, err := s.sup.ViewURL(r.Context(), sandboxID)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": url})
}

type shareRequest struct {
	ProjectName string `json:"projectName,omitempty"`
	TTLSec      int    `json:"ttlSec,omitempty"`
}

func (s *Server) share(w http.ResponseWriter, r *http.Request) {
	sandboxID, ok := s.guard(w, r)
	if !ok {
		return
	}
	var in shareRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	res, err := s.sup.Share(r.Context(), sandboxID, in.TTLSec, in.ProjectName)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	if res == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "session not found"})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) terminate(w http.ResponseWriter, r *http.Request) {
	sandboxID, ok := s.guard(w, r)
	if !ok {
		return
	}
	if err := s.sup.Terminate(r.Context(), sandboxID); err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"terminated": true})
}

type proxyRequest struct {
	PreviewURL string          `json:"previewUrl"`
	Method     string          `json:"method,omitempty"`
	Path       string          `json:"path"`
	Body       json.RawMessage `json:"body,omitempty"`
}

// proxy relays a REST call to a sandbox (same CORS-dodging role as the daemon's
// /cloud/proxy). The previewUrl must belong to one of the tenant's sandboxes.
func (s *Server) proxy(w http.ResponseWriter, r *http.Request) {
	tenant := TenantFromContext(r.Context())
	var in proxyRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if in.PreviewURL == "" || in.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "previewUrl and path are required"})
		return
	}
	if !s.tenantOwnsPreview(tenant, in.PreviewURL) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "preview url not owned by tenant"})
		return
	}
	method := in.Method
	if method == "" {
		method = http.MethodGet
	}
	var body any
	if len(in.Body) > 0 {
		body = in.Body
	}
	status, raw, err := s.sup.ProxyFetch(r.Context(), in.PreviewURL, method, in.Path, body)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	out := map[string]any{"ok": status >= 200 && status < 300, "status": status}
	if len(raw) > 0 {
		out["json"] = json.RawMessage(raw)
	} else {
		out["json"] = nil
	}
	writeJSON(w, http.StatusOK, out)
}

// tenantOwnsPreview checks the previewUrl matches a sandbox the tenant owns —
// prevents a tenant relaying to another tenant's (or an arbitrary) sandbox.
func (s *Server) tenantOwnsPreview(tenant, previewURL string) bool {
	for _, sess := range s.sup.ListSessionsForTenant(tenant) {
		if sess.PreviewURL != "" && sess.PreviewURL == previewURL {
			return true
		}
	}
	return false
}

func (s *Server) writeErr(w http.ResponseWriter, err error) {
	s.log.Error("controlplane request failed", "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal", "message": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
