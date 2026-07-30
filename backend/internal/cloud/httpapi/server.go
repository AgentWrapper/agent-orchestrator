// Package httpapi serves the authenticated AO Cloud control-plane API.
package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudevents "github.com/aoagents/agent-orchestrator/backend/internal/cloud/events"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/daytona"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
	shareddomain "github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type store interface {
	Ping(context.Context) error
	EnsureAccount(context.Context, string, string) (clouddomain.Account, error)
	CreateProject(context.Context, clouddomain.AccountID, cloudpostgres.CreateProjectInput) (clouddomain.Project, error)
	ListProjects(context.Context, clouddomain.AccountID) ([]clouddomain.Project, error)
	CreateSession(context.Context, clouddomain.AccountID, cloudpostgres.CreateSessionInput) (cloudpostgres.CreateSessionResult, error)
	ListSessions(context.Context, clouddomain.AccountID) ([]clouddomain.Session, error)
	GetSession(context.Context, clouddomain.AccountID, clouddomain.SessionID) (clouddomain.Session, error)
	GetSandbox(context.Context, clouddomain.AccountID, clouddomain.SessionID) (clouddomain.Sandbox, error)
	SetSandboxDesiredState(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) error
	ConsumeAccessTicket(context.Context, string, string) (cloudpostgres.ConsumedTicket, error)
	MarkWorkerSeen(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, string, int64, []string) error
	WorkerLaunchSpec(context.Context, clouddomain.AccountID, clouddomain.SessionID) (cloudpostgres.WorkerLaunchSpec, error)
	UpdateSessionActivity(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) error
	WorkerConnectionCurrent(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, int64) (bool, error)
	LatestEventSequenceByType(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) (int64, error)
	LatestPromptAcceptedSequence(context.Context, clouddomain.AccountID, clouddomain.SessionID) (int64, error)
	SetAgentSessionID(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) error
	UpsertProviderConnection(context.Context, clouddomain.AccountID, string, string, []byte, []byte, json.RawMessage) (cloudpostgres.ProviderConnection, error)
	ListProviderConnections(context.Context, clouddomain.AccountID) ([]cloudpostgres.ProviderConnection, error)
	ProviderConnectionSecretByProvider(context.Context, clouddomain.AccountID, string, string) ([]byte, []byte, json.RawMessage, error)
	DeleteProviderConnection(context.Context, clouddomain.AccountID, string, string) error
	IssueAccessTicket(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, []string, time.Duration) (string, error)
	SessionSCM(context.Context, clouddomain.AccountID, clouddomain.SessionID) (*cloudpostgres.SessionSCM, error)
}

// Server serves the authenticated AO Cloud HTTP and WebSocket APIs.
type Server struct {
	store            store
	events           *cloudevents.Service
	auth             *cloudauth.Verifier
	workerTokens     *cloudworker.TokenManager
	secretCipher     *cloudsecrets.Cipher
	agentCredentials *agentCredentialValidator
	sandboxProvider  string
	daytonaAPIURL    string
	daytonaTarget    string
	workerHub        *cloudworkerhub.Hub
	localGitHub      *cloudlocalgh.Client
	webOrigin        string
	webOriginHost    string
	log              *slog.Logger
	handler          http.Handler
}

// New creates an AO Cloud API server.
func New(
	store store,
	events *cloudevents.Service,
	auth *cloudauth.Verifier,
	workerTokens *cloudworker.TokenManager,
	secretCipher *cloudsecrets.Cipher,
	sandboxProvider string,
	daytonaAPIURL, daytonaTarget string,
	workerHub *cloudworkerhub.Hub,
	localGitHub *cloudlocalgh.Client,
	webOrigin string,
	log *slog.Logger,
) *Server {
	if log == nil {
		log = slog.Default()
	}
	server := &Server{
		store:            store,
		events:           events,
		auth:             auth,
		workerTokens:     workerTokens,
		secretCipher:     secretCipher,
		agentCredentials: newAgentCredentialValidator(nil),
		sandboxProvider:  sandboxProvider,
		daytonaAPIURL:    strings.TrimRight(daytonaAPIURL, "/"),
		daytonaTarget:    daytonaTarget,
		workerHub:        workerHub,
		localGitHub:      localGitHub,
		webOrigin:        strings.TrimRight(webOrigin, "/"),
		log:              log,
	}
	if parsed, err := url.Parse(server.webOrigin); err == nil {
		server.webOriginHost = parsed.Host
	}
	server.handler = server.routes()
	return server
}

// Handler returns the configured AO Cloud HTTP handler.
func (s *Server) Handler() http.Handler {
	return s.handler
}

type accountContextKey struct{}

func accountFromContext(ctx context.Context) (clouddomain.Account, bool) {
	account, ok := ctx.Value(accountContextKey{}).(clouddomain.Account)
	return account, ok
}

func (s *Server) routes() http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Recoverer)
	router.Use(s.cors)
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "ao-cloud"})
	})
	router.Get("/readyz", s.ready)

	router.Route("/api/cloud/v1", func(api chi.Router) {
		api.Post("/worker/bootstrap", s.workerBootstrap)
		api.Get("/terminal", s.terminalSocket)
		api.Group(func(worker chi.Router) {
			worker.Use(s.workerAuth)
			worker.Post("/worker/heartbeat", s.workerHeartbeat)
			worker.Post("/worker/events", s.workerEvent)
			worker.Get("/worker/connect", s.workerConnect)
			worker.Get("/worker/orchestrate/sessions", s.workerListSessions)
			worker.Post("/worker/orchestrate/sessions", s.workerCreateSession)
			worker.Post("/worker/orchestrate/sessions/{sessionId}/messages", s.workerSendMessage)
			worker.Handle("/git/{owner}/{repository}.git/*", http.HandlerFunc(s.gitProxy))
		})

		api.Group(func(protected chi.Router) {
			protected.Use(s.auth.Middleware)
			protected.Use(s.ensureAccount)
			protected.Get("/me", s.me)
			protected.Get("/projects", s.listProjects)
			protected.Post("/projects", s.createProject)
			protected.Get("/sessions", s.listSessions)
			protected.Post("/sessions", s.createSession)
			protected.Get("/sessions/{sessionId}", s.getSession)
			protected.Post("/sessions/{sessionId}/desired-state", s.setDesiredState)
			protected.Get("/sessions/{sessionId}/chat-events", s.chatEvents)
			protected.Post("/sessions/{sessionId}/messages", s.sendMessage)
			protected.Post("/sessions/{sessionId}/interrupt", s.interruptSession)
			protected.Get("/sessions/{sessionId}/events", s.streamEvents)
			protected.Get("/sessions/{sessionId}/scm", s.sessionSCM)
			protected.Post("/sessions/{sessionId}/terminal-ticket", s.issueTerminalTicket)
			protected.Get("/provider-connections", s.listProviderConnections)
			protected.Put("/provider-connections/daytona", s.putDaytonaConnection)
			protected.Put("/provider-connections/agents/{agent}", s.putAgentConnection)
			protected.Delete("/provider-connections/agents/{agent}", s.deleteAgentConnection)
			protected.Get("/repositories", s.listRepositories)
		})
	})
	return router
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "NOT_READY", "Cloud persistence is unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready", "service": "ao-cloud"})
}

func (s *Server) ensureAccount(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := cloudauth.PrincipalFromContext(r.Context())
		if !ok {
			writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
			return
		}
		account, err := s.store.EnsureAccount(r.Context(), principal.UserID, principal.DisplayName)
		if err != nil {
			s.internalError(w, r, "ensure account", err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), accountContextKey{}, account)))
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	account, _ := accountFromContext(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{
			"id":          principal.UserID,
			"email":       principal.Email,
			"displayName": principal.DisplayName,
		},
		"account":         account,
		"sandboxProvider": s.sandboxProvider,
	})
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	var input struct {
		DisplayName   string          `json:"displayName"`
		RepositoryURL string          `json:"repositoryUrl"`
		DefaultBranch string          `json:"defaultBranch"`
		Config        json.RawMessage `json:"config"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.RepositoryURL = strings.TrimSpace(input.RepositoryURL)
	input.DefaultBranch = strings.TrimSpace(input.DefaultBranch)
	if input.DisplayName == "" || !validGitHubRepositoryURL(input.RepositoryURL) {
		writeError(w, r, http.StatusBadRequest, "INVALID_PROJECT", "A name and HTTPS GitHub repository URL are required.")
		return
	}
	if input.DefaultBranch == "" {
		input.DefaultBranch = "main"
	}
	project, err := s.store.CreateProject(r.Context(), account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   input.DisplayName,
		RepositoryURL: input.RepositoryURL,
		DefaultBranch: input.DefaultBranch,
		Config:        input.Config,
	})
	if err != nil {
		s.internalError(w, r, "create project", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"project": project})
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	projects, err := s.store.ListProjects(r.Context(), account.ID)
	if err != nil {
		s.internalError(w, r, "list projects", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		writeError(w, r, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.")
		return
	}
	var input struct {
		ProjectID            clouddomain.ProjectID       `json:"projectId"`
		Kind                 string                      `json:"kind"`
		Harness              string                      `json:"harness"`
		DisplayName          string                      `json:"displayName"`
		Branch               string                      `json:"branch"`
		Prompt               string                      `json:"prompt"`
		Resource             clouddomain.ResourceProfile `json:"resource"`
		ProviderConnectionID string                      `json:"providerConnectionId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Kind == "" {
		input.Kind = "worker"
	}
	if input.Kind != "worker" && input.Kind != "orchestrator" {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION_KIND", "kind must be worker or orchestrator.")
		return
	}
	if !shareddomain.AgentHarness(input.Harness).IsKnown() {
		writeError(w, r, http.StatusBadRequest, "INVALID_AGENT", "The selected coding agent is not supported.")
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.ProjectID == "" || input.DisplayName == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION", "projectId and displayName are required.")
		return
	}
	if input.Resource == (clouddomain.ResourceProfile{}) {
		input.Resource = clouddomain.DefaultResourceProfile()
	}
	if input.Resource.CPU < 1 || input.Resource.CPU > 4 ||
		input.Resource.Memory < 1 || input.Resource.Memory > 8 ||
		input.Resource.Disk < 3 || input.Resource.Disk > 10 {
		writeError(w, r, http.StatusBadRequest, "INVALID_RESOURCE_PROFILE", "Resource profile exceeds Cloud V1 limits.")
		return
	}
	credential, err := s.loadAgentCredential(r.Context(), account.ID, input.Harness)
	if errors.Is(err, errAgentConnectionRequired) {
		writeError(
			w,
			r,
			http.StatusBadRequest,
			"AGENT_CONNECTION_REQUIRED",
			"Connect "+input.Harness+" before creating a cloud session.",
		)
		return
	}
	if err != nil {
		s.internalError(w, r, "validate agent connection", err)
		return
	}
	if credential != nil {
		credential.Secret = ""
	}
	result, err := s.store.CreateSession(r.Context(), account.ID, cloudpostgres.CreateSessionInput{
		IdempotencyKey:       idempotencyKey,
		ProjectID:            input.ProjectID,
		Kind:                 input.Kind,
		Harness:              input.Harness,
		DisplayName:          input.DisplayName,
		Branch:               strings.TrimSpace(input.Branch),
		Prompt:               input.Prompt,
		Resource:             input.Resource,
		Provider:             s.sandboxProvider,
		ProviderConnectionID: providerConnectionID(s.sandboxProvider, input.ProviderConnectionID),
	})
	if errors.Is(err, cloudpostgres.ErrProjectNotFound) {
		writeError(w, r, http.StatusNotFound, "PROJECT_NOT_FOUND", "The cloud project does not exist.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrProviderConnectionNotFound) {
		writeError(w, r, http.StatusBadRequest, "PROVIDER_CONNECTION_NOT_FOUND", "The selected Daytona connection does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "create session", err)
		return
	}
	status := http.StatusCreated
	if !result.Created {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func providerConnectionID(provider, connectionID string) string {
	if provider != "daytona" {
		return ""
	}
	return connectionID
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessions, err := s.store.ListSessions(r.Context(), account.ID)
	if err != nil {
		s.internalError(w, r, "list sessions", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	session, err := s.store.GetSession(
		r.Context(),
		account.ID,
		clouddomain.SessionID(chi.URLParam(r, "sessionId")),
	)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "get session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": session})
}

func (s *Server) chatEvents(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize chat event replay", err)
		return
	}
	after, err := parseAfter(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_AFTER", "after must be a non-negative integer.")
		return
	}
	limit, err := parseLimit(r, 500)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_LIMIT", "limit must be a positive integer no greater than 500.")
		return
	}
	events, err := s.events.ReplayChat(r.Context(), account.ID, sessionID, after, limit)
	if err != nil {
		s.internalError(w, r, "replay chat events", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize cloud message", err)
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		writeError(w, r, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.")
		return
	}
	var input struct {
		Text string `json:"text"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Text) == "" || len([]byte(input.Text)) > 64<<10 {
		writeError(w, r, http.StatusBadRequest, "INVALID_MESSAGE", "text must be non-empty and at most 64 KiB.")
		return
	}
	event, err := s.events.AppendUserMessage(
		r.Context(),
		account.ID,
		sessionID,
		idempotencyKey,
		input.Text,
	)
	if errors.Is(err, cloudpostgres.ErrIdempotencyConflict) {
		writeError(w, r, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another command.")
		return
	}
	if err != nil {
		s.internalError(w, r, "append cloud message", err)
		return
	}
	if err := s.wakeSessionForMessage(r.Context(), account.ID, sessionID); err != nil {
		s.internalError(w, r, "wake cloud session for message", err)
		return
	}
	command := cloudworkerhub.Command{
		Type:     "prompt",
		Data:     base64.StdEncoding.EncodeToString([]byte(input.Text)),
		Sequence: event.Sequence,
	}
	if err := s.workerHub.Send(sessionID, command); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "WORKER_BACKPRESSURE", "The message was saved but worker delivery is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func (s *Server) wakeSessionForMessage(
	ctx context.Context,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
) error {
	sandbox, err := s.store.GetSandbox(ctx, accountID, sessionID)
	if err != nil {
		return err
	}
	if sandbox.DesiredState != "running" {
		if err := s.store.SetSandboxDesiredState(ctx, accountID, sessionID, "running"); err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]string{
			"state":  "running",
			"source": "message",
		})
		if _, err := s.events.Append(
			ctx,
			accountID,
			sessionID,
			"sandbox.desired_state_changed",
			payload,
		); err != nil {
			return err
		}
	}
	return s.store.UpdateSessionActivity(ctx, accountID, sessionID, "active")
}

func (s *Server) interruptSession(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize cloud interrupt", err)
		return
	}
	payload, _ := json.Marshal(map[string]string{"source": "browser"})
	event, err := s.events.Append(
		r.Context(),
		account.ID,
		sessionID,
		"chat.interrupt_requested",
		payload,
	)
	if err != nil {
		s.internalError(w, r, "append interrupt request", err)
		return
	}
	if err := s.store.UpdateSessionActivity(r.Context(), account.ID, sessionID, "idle"); err != nil {
		s.internalError(w, r, "update interrupt activity", err)
		return
	}
	if err := s.workerHub.Send(sessionID, cloudworkerhub.Command{
		Type:     "interrupt",
		Sequence: event.Sequence,
	}); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "WORKER_BACKPRESSURE", "The interrupt was saved but worker delivery is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func (s *Server) sessionSCM(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize cloud SCM read", err)
		return
	}
	scm, err := s.store.SessionSCM(r.Context(), account.ID, sessionID)
	if err != nil {
		s.internalError(w, r, "read cloud SCM", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scm": scm})
}

func (s *Server) setDesiredState(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	var input struct {
		State string `json:"state"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	switch input.State {
	case "running", "paused", "deleted":
	default:
		writeError(w, r, http.StatusBadRequest, "INVALID_DESIRED_STATE", "state must be running, paused, or deleted.")
		return
	}
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if err := s.store.SetSandboxDesiredState(r.Context(), account.ID, sessionID, input.State); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "set desired state", err)
		return
	}
	eventPayload, _ := json.Marshal(map[string]string{"state": input.State})
	if _, err := s.events.Append(r.Context(), account.ID, sessionID, "sandbox.desired_state_changed", eventPayload); err != nil {
		s.internalError(w, r, "append desired-state event", err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "state": input.State})
}

func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize event stream", err)
		return
	}
	after, err := parseAfter(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_AFTER", "after must be a non-negative integer.")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusInternalServerError, "SSE_UNSUPPORTED", "Streaming is unavailable.")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	live := make(chan clouddomain.Event, 1024)
	unsubscribe := s.events.Subscribe(account.ID, sessionID, func(event clouddomain.Event) {
		select {
		case live <- event:
		default:
			cancel()
		}
	})
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sent := after
	if err := s.writeEventReplay(ctx, w, flusher, account.ID, sessionID, &sent); err != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-live:
			if err := s.writeEventReplay(ctx, w, flusher, account.ID, sessionID, &sent); err != nil {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) writeEventReplay(
	ctx context.Context,
	w http.ResponseWriter,
	flusher http.Flusher,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	sent *int64,
) error {
	for {
		replayed, err := s.events.Replay(ctx, accountID, sessionID, *sent, 500)
		if err != nil {
			return err
		}
		for _, event := range replayed {
			if err := writeSSE(w, flusher, event, sent); err != nil {
				return err
			}
		}
		if len(replayed) < 500 {
			return nil
		}
	}
}

func (s *Server) workerBootstrap(w http.ResponseWriter, r *http.Request) {
	var input struct {
		BootstrapToken string   `json:"bootstrapToken"`
		Version        string   `json:"version"`
		Capabilities   []string `json:"capabilities"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	ticket, err := s.store.ConsumeAccessTicket(r.Context(), input.BootstrapToken, "worker_bootstrap")
	if errors.Is(err, cloudpostgres.ErrInvalidTicket) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_BOOTSTRAP", "Worker bootstrap token is invalid or expired.")
		return
	}
	if err != nil {
		s.internalError(w, r, "consume worker bootstrap", err)
		return
	}
	launchSpec, err := s.store.WorkerLaunchSpec(r.Context(), ticket.AccountID, ticket.SessionID)
	if err != nil {
		s.internalError(w, r, "load worker launch spec", err)
		return
	}
	agentCredential, err := s.loadAgentCredential(
		r.Context(),
		ticket.AccountID,
		launchSpec.Session.Harness,
	)
	if errors.Is(err, errAgentConnectionRequired) {
		writeError(
			w,
			r,
			http.StatusBadRequest,
			"AGENT_CONNECTION_REQUIRED",
			"The coding-agent connection required by this session is unavailable.",
		)
		return
	}
	if err != nil {
		s.internalError(w, r, "load worker agent credential", err)
		return
	}
	if agentCredential != nil {
		defer func() { agentCredential.Secret = "" }()
	}
	epoch := time.Now().UnixNano()
	workerID := cloudworker.NextWorkerID(ticket.SessionID, epoch)
	if err := s.store.MarkWorkerSeen(
		r.Context(),
		ticket.AccountID,
		ticket.SessionID,
		workerID,
		input.Version,
		epoch,
		input.Capabilities,
	); err != nil {
		s.internalError(w, r, "register worker", err)
		return
	}
	token, err := s.workerTokens.Issue(cloudworker.Claims{
		AccountID: ticket.AccountID,
		SessionID: ticket.SessionID,
		WorkerID:  workerID,
		Epoch:     epoch,
		Scopes:    ticket.Scopes,
	}, 15*time.Minute)
	if err != nil {
		s.internalError(w, r, "issue worker token", err)
		return
	}
	payload, _ := json.Marshal(map[string]any{"workerId": workerID, "epoch": epoch})
	_, _ = s.events.Append(r.Context(), ticket.AccountID, ticket.SessionID, "worker.connected", payload)
	writeJSON(w, http.StatusOK, cloudworker.BootstrapResponse{
		WorkerToken:     token,
		WorkerID:        workerID,
		Epoch:           epoch,
		ExpiresIn:       900,
		SessionID:       string(ticket.SessionID),
		Launch:          launchSpec,
		AgentCredential: agentCredential,
	})
}

type workerContextKey struct{}

func (s *Server) workerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scheme, token, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
		if !ok || !strings.EqualFold(scheme, "Worker") {
			writeError(w, r, http.StatusUnauthorized, "WORKER_AUTH_REQUIRED", "A valid worker credential is required.")
			return
		}
		claims, err := s.workerTokens.Verify(token)
		if err != nil {
			writeError(w, r, http.StatusUnauthorized, "INVALID_WORKER_TOKEN", "Worker credential is invalid or expired.")
			return
		}
		current, err := s.store.WorkerConnectionCurrent(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			claims.WorkerID,
			claims.Epoch,
		)
		if err != nil {
			s.internalError(w, r, "validate worker epoch", err)
			return
		}
		if !current {
			writeError(w, r, http.StatusUnauthorized, "STALE_WORKER_TOKEN", "Worker credential has been replaced.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workerContextKey{}, claims)))
	})
}

func workerFromContext(ctx context.Context) cloudworker.Claims {
	claims, _ := ctx.Value(workerContextKey{}).(cloudworker.Claims)
	return claims
}

func (s *Server) workerOrchestrator(
	w http.ResponseWriter,
	r *http.Request,
) (cloudworker.Claims, clouddomain.Session, bool) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:orchestrate") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:orchestrate scope is required.")
		return cloudworker.Claims{}, clouddomain.Session{}, false
	}
	if strings.TrimSpace(r.Header.Get("X-AO-Session-ID")) != string(claims.SessionID) {
		writeError(w, r, http.StatusForbidden, "SESSION_ID_MISMATCH", "Worker session identity does not match its credential.")
		return cloudworker.Claims{}, clouddomain.Session{}, false
	}
	session, err := s.store.GetSession(r.Context(), claims.AccountID, claims.SessionID)
	if err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusForbidden, "ORCHESTRATOR_REQUIRED", "Only an active orchestrator may coordinate workers.")
			return cloudworker.Claims{}, clouddomain.Session{}, false
		}
		s.internalError(w, r, "authorize worker orchestration", err)
		return cloudworker.Claims{}, clouddomain.Session{}, false
	}
	if session.Kind != "orchestrator" || session.IsTerminated {
		writeError(w, r, http.StatusForbidden, "ORCHESTRATOR_REQUIRED", "Only an active orchestrator may coordinate workers.")
		return cloudworker.Claims{}, clouddomain.Session{}, false
	}
	return claims, session, true
}

func (s *Server) workerCreateSession(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		writeError(w, r, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.")
		return
	}
	var input struct {
		DisplayName string `json:"displayName"`
		Prompt      string `json:"prompt"`
		Harness     string `json:"harness"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName == "" || len(input.DisplayName) > 200 {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION", "displayName is required and must be at most 200 characters.")
		return
	}
	if strings.TrimSpace(input.Prompt) == "" || len([]byte(input.Prompt)) > 64<<10 {
		writeError(w, r, http.StatusBadRequest, "INVALID_PROMPT", "prompt must be non-empty and at most 64 KiB.")
		return
	}
	input.Harness = strings.TrimSpace(input.Harness)
	if input.Harness == "" {
		input.Harness = parent.Harness
	}
	if !cloudWorkerHarness(input.Harness) {
		writeError(w, r, http.StatusBadRequest, "INVALID_AGENT", "harness must be claude-code, codex, or cursor.")
		return
	}
	credential, err := s.loadAgentCredential(r.Context(), claims.AccountID, input.Harness)
	if credential != nil {
		credential.Secret = ""
	}
	if errors.Is(err, errAgentConnectionRequired) {
		writeError(w, r, http.StatusBadRequest, "AGENT_CONNECTION_REQUIRED", "Connect "+input.Harness+" before spawning this worker.")
		return
	}
	if err != nil {
		s.internalError(w, r, "validate spawned worker agent connection", err)
		return
	}
	parentSandbox, err := s.store.GetSandbox(r.Context(), claims.AccountID, parent.ID)
	if err != nil {
		s.internalError(w, r, "load orchestrator sandbox", err)
		return
	}
	result, err := s.store.CreateSession(r.Context(), claims.AccountID, cloudpostgres.CreateSessionInput{
		IdempotencyKey:       idempotencyKey,
		ProjectID:            parent.ProjectID,
		Kind:                 "worker",
		Harness:              input.Harness,
		DisplayName:          input.DisplayName,
		Prompt:               input.Prompt,
		Resource:             parentSandbox.ResourceProfile,
		Provider:             parentSandbox.Provider,
		ProviderConnectionID: parentSandbox.ProviderConnectionID,
	})
	if errors.Is(err, cloudpostgres.ErrIdempotencyConflict) {
		writeError(w, r, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another command.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrProviderConnectionNotFound) {
		writeError(w, r, http.StatusBadRequest, "PROVIDER_CONNECTION_NOT_FOUND", "The orchestrator sandbox provider connection is unavailable.")
		return
	}
	if err != nil {
		s.internalError(w, r, "spawn orchestrated worker", err)
		return
	}
	status := http.StatusCreated
	if !result.Created {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (s *Server) workerListSessions(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	sessions, err := s.store.ListSessions(r.Context(), claims.AccountID)
	if err != nil {
		s.internalError(w, r, "list orchestrated sessions", err)
		return
	}
	projectSessions := make([]clouddomain.Session, 0, len(sessions))
	for _, session := range sessions {
		if session.ProjectID == parent.ProjectID {
			projectSessions = append(projectSessions, session)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": projectSessions})
}

func (s *Server) workerSendMessage(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	targetID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	target, err := s.store.GetSession(r.Context(), claims.AccountID, targetID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) ||
		err == nil && target.ProjectID != parent.ProjectID {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The project session does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "authorize orchestrated message", err)
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		writeError(w, r, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.")
		return
	}
	var input struct {
		Text string `json:"text"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Text) == "" || len([]byte(input.Text)) > 64<<10 {
		writeError(w, r, http.StatusBadRequest, "INVALID_MESSAGE", "text must be non-empty and at most 64 KiB.")
		return
	}
	event, err := s.events.AppendUserMessage(r.Context(), claims.AccountID, targetID, idempotencyKey, input.Text)
	if errors.Is(err, cloudpostgres.ErrIdempotencyConflict) {
		writeError(w, r, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another command.")
		return
	}
	if err != nil {
		s.internalError(w, r, "append orchestrated message", err)
		return
	}
	if err := s.wakeSessionForMessage(r.Context(), claims.AccountID, targetID); err != nil {
		s.internalError(w, r, "wake orchestrated session for message", err)
		return
	}
	if err := s.workerHub.Send(targetID, cloudworkerhub.Command{
		Type:     "prompt",
		Data:     base64.StdEncoding.EncodeToString([]byte(input.Text)),
		Sequence: event.Sequence,
	}); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "WORKER_BACKPRESSURE", "The message was saved but worker delivery is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func cloudWorkerHarness(harness string) bool {
	return harness == "claude-code" || harness == "codex" || harness == "cursor"
}

func (s *Server) workerHeartbeat(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:connect") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:connect scope is required.")
		return
	}
	var input struct {
		Version      string   `json:"version"`
		Capabilities []string `json:"capabilities"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.MarkWorkerSeen(
		r.Context(),
		claims.AccountID,
		claims.SessionID,
		claims.WorkerID,
		input.Version,
		claims.Epoch,
		input.Capabilities,
	); err != nil {
		s.internalError(w, r, "record worker heartbeat", err)
		return
	}
	renewed, err := s.workerTokens.Issue(claims, 15*time.Minute)
	if err != nil {
		s.internalError(w, r, "renew worker token", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workerToken": renewed, "expiresIn": 900})
}

func (s *Server) workerEvent(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:event") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:event scope is required.")
		return
	}
	var input struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Type = strings.TrimSpace(input.Type)
	if input.Type == "" || len(input.Type) > 100 || !strings.HasPrefix(input.Type, "worker.") &&
		!strings.HasPrefix(input.Type, "agent.") && !strings.HasPrefix(input.Type, "terminal.") &&
		!strings.HasPrefix(input.Type, "repository.") && !strings.HasPrefix(input.Type, "preview.") &&
		!strings.HasPrefix(input.Type, "chat.") {
		writeError(w, r, http.StatusBadRequest, "INVALID_EVENT_TYPE", "Worker event type is not allowed.")
		return
	}
	if input.Type == "agent.activity" {
		var activity struct {
			State       string `json:"state"`
			HasActivity bool   `json:"hasActivity"`
		}
		if err := json.Unmarshal(input.Payload, &activity); err != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_ACTIVITY_EVENT", "Agent activity payload is invalid.")
			return
		}
		if activity.HasActivity {
			switch activity.State {
			case "active", "idle", "waiting_input", "blocked", "exited":
			default:
				writeError(w, r, http.StatusBadRequest, "INVALID_ACTIVITY_STATE", "Agent activity state is invalid.")
				return
			}
			if err := s.store.UpdateSessionActivity(
				r.Context(),
				claims.AccountID,
				claims.SessionID,
				activity.State,
			); err != nil {
				s.internalError(w, r, "update worker activity", err)
				return
			}
		}
	}
	switch input.Type {
	case "chat.turn_started":
		if err := s.store.UpdateSessionActivity(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			"active",
		); err != nil {
			s.internalError(w, r, "update chat turn activity", err)
			return
		}
	case "chat.turn_completed", "chat.turn_interrupted":
		if err := s.store.UpdateSessionActivity(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			"idle",
		); err != nil {
			s.internalError(w, r, "update chat turn activity", err)
			return
		}
	}
	if input.Type == "chat.session_started" {
		var session struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal(input.Payload, &session); err != nil ||
			strings.TrimSpace(session.SessionID) == "" ||
			len(session.SessionID) > 200 {
			writeError(w, r, http.StatusBadRequest, "INVALID_AGENT_SESSION", "Agent session payload is invalid.")
			return
		}
		if err := s.store.SetAgentSessionID(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			session.SessionID,
		); err != nil {
			s.internalError(w, r, "store agent session ID", err)
			return
		}
	}
	event, err := s.events.Append(r.Context(), claims.AccountID, claims.SessionID, input.Type, input.Payload)
	if err != nil {
		s.internalError(w, r, "append worker event", err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func (s *Server) workerConnect(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:terminal") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:terminal scope is required.")
		return
	}
	after, err := parseAfter(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_AFTER", "after must be a non-negative integer.")
		return
	}
	socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer func() { _ = socket.Close(websocket.StatusNormalClosure, "worker connection closed") }()
	commands, unregister := s.workerHub.Register(
		claims.SessionID,
		claims.WorkerID,
		claims.Epoch,
	)
	defer unregister()
	accepted, err := s.store.LatestPromptAcceptedSequence(
		r.Context(),
		claims.AccountID,
		claims.SessionID,
	)
	if err != nil {
		return
	}
	interrupted, err := s.store.LatestEventSequenceByType(
		r.Context(),
		claims.AccountID,
		claims.SessionID,
		"chat.interrupt_requested",
	)
	if err != nil {
		return
	}
	replayedAfter := max(after, accepted, interrupted)
	if err := s.writePromptReplay(r.Context(), socket, claims, &replayedAfter); err != nil {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case command, ok := <-commands:
			if !ok {
				_ = socket.Close(websocket.StatusPolicyViolation, "worker replaced")
				return
			}
			if command.Type == "prompt" {
				if err := s.writePromptReplay(r.Context(), socket, claims, &replayedAfter); err != nil {
					return
				}
				continue
			}
			encoded, _ := json.Marshal(command)
			if err := socket.Write(r.Context(), websocket.MessageText, encoded); err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			err := socket.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (s *Server) writePromptReplay(
	ctx context.Context,
	socket *websocket.Conn,
	claims cloudworker.Claims,
	replayedAfter *int64,
) error {
	for {
		replayed, err := s.events.ReplayChat(
			ctx,
			claims.AccountID,
			claims.SessionID,
			*replayedAfter,
			500,
		)
		if err != nil {
			return err
		}
		for _, event := range replayed {
			if event.Sequence > *replayedAfter {
				*replayedAfter = event.Sequence
			}
			if event.Type != "chat.user_message" {
				continue
			}
			var payload struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(event.Payload, &payload) != nil ||
				payload.Text == "" {
				continue
			}
			command := cloudworkerhub.Command{
				Type:     "prompt",
				Data:     base64.StdEncoding.EncodeToString([]byte(payload.Text)),
				Sequence: event.Sequence,
			}
			encoded, marshalErr := json.Marshal(command)
			if marshalErr != nil {
				return marshalErr
			}
			if err := socket.Write(ctx, websocket.MessageText, encoded); err != nil {
				return err
			}
		}
		if len(replayed) < 500 {
			return nil
		}
	}
}

func (s *Server) issueTerminalTicket(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize terminal ticket", err)
		return
	}
	ticket, err := s.store.IssueAccessTicket(
		r.Context(),
		account.ID,
		sessionID,
		"terminal",
		[]string{"terminal:read", "terminal:operate"},
		60*time.Second,
	)
	if err != nil {
		s.internalError(w, r, "issue terminal ticket", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket":    ticket,
		"expiresIn": 60,
	})
}

type terminalClientCommand struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

type terminalServerMessage struct {
	Type     string `json:"type"`
	Data     string `json:"data,omitempty"`
	Sequence int64  `json:"sequence,omitempty"`
	Message  string `json:"message,omitempty"`
}

func (s *Server) terminalSocket(w http.ResponseWriter, r *http.Request) {
	ticket, err := s.store.ConsumeAccessTicket(r.Context(), r.URL.Query().Get("ticket"), "terminal")
	if errors.Is(err, cloudpostgres.ErrInvalidTicket) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_TERMINAL_TICKET", "Terminal ticket is invalid or expired.")
		return
	}
	if err != nil {
		s.internalError(w, r, "consume terminal ticket", err)
		return
	}
	after, err := parseAfter(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_AFTER", "after must be a non-negative integer.")
		return
	}
	socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  []string{s.webOriginHost},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer func() { _ = socket.Close(websocket.StatusNormalClosure, "terminal closed") }()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	live := make(chan clouddomain.Event, 1024)
	unsubscribe := s.events.Subscribe(ticket.AccountID, ticket.SessionID, func(event clouddomain.Event) {
		if event.Type != "terminal.output" && event.Type != "worker.connected" {
			return
		}
		select {
		case live <- event:
		default:
			cancel()
		}
	})
	defer unsubscribe()

	resetSequence, err := s.store.LatestEventSequenceByType(
		ctx,
		ticket.AccountID,
		ticket.SessionID,
		"worker.connected",
	)
	if err != nil {
		return
	}
	if resetSequence > after {
		if err := writeTerminalMessage(ctx, socket, terminalServerMessage{
			Type:     "reset",
			Sequence: resetSequence,
		}); err != nil {
			return
		}
		after = resetSequence
	}
	sent := after
	for {
		replayed, err := s.events.Replay(ctx, ticket.AccountID, ticket.SessionID, sent, 500)
		if err != nil {
			return
		}
		for _, event := range replayed {
			if event.Type == "terminal.output" {
				if err := writeTerminalEvent(ctx, socket, event, &sent); err != nil {
					return
				}
			} else if event.Sequence > sent {
				sent = event.Sequence
			}
		}
		if len(replayed) < 500 {
			break
		}
	}

	clientCommands := make(chan terminalClientCommand, 64)
	readErrors := make(chan error, 1)
	go func() {
		for {
			_, data, err := socket.Read(ctx)
			if err != nil {
				readErrors <- err
				return
			}
			var command terminalClientCommand
			if err := json.Unmarshal(data, &command); err != nil {
				readErrors <- err
				return
			}
			select {
			case clientCommands <- command:
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-readErrors:
			return
		case event := <-live:
			if event.Type == "worker.connected" {
				if event.Sequence <= sent {
					continue
				}
				if err := writeTerminalMessage(ctx, socket, terminalServerMessage{
					Type:     "reset",
					Sequence: event.Sequence,
				}); err != nil {
					return
				}
				sent = event.Sequence
			} else {
				if err := writeTerminalEvent(ctx, socket, event, &sent); err != nil {
					return
				}
			}
		case command := <-clientCommands:
			workerCommand, err := validateTerminalCommand(command)
			if err != nil {
				_ = writeTerminalMessage(ctx, socket, terminalServerMessage{
					Type:    "error",
					Message: err.Error(),
				})
				continue
			}
			if err := s.workerHub.Send(ticket.SessionID, workerCommand); err != nil {
				_ = writeTerminalMessage(ctx, socket, terminalServerMessage{
					Type:    "error",
					Message: "Cloud worker is not connected.",
				})
			}
		}
	}
}

func validateTerminalCommand(command terminalClientCommand) (cloudworkerhub.Command, error) {
	switch command.Type {
	case "input":
		decoded, err := base64.StdEncoding.DecodeString(command.Data)
		if err != nil || len(decoded) == 0 || len(decoded) > 64<<10 {
			return cloudworkerhub.Command{}, errors.New("terminal input is invalid")
		}
		return cloudworkerhub.Command{Type: "input", Data: command.Data}, nil
	case "resize":
		if command.Rows == 0 || command.Cols == 0 || command.Rows > 1000 || command.Cols > 1000 {
			return cloudworkerhub.Command{}, errors.New("terminal size is invalid")
		}
		return cloudworkerhub.Command{Type: "resize", Rows: command.Rows, Cols: command.Cols}, nil
	default:
		return cloudworkerhub.Command{}, errors.New("terminal command type is invalid")
	}
}

func writeTerminalEvent(
	ctx context.Context,
	socket *websocket.Conn,
	event clouddomain.Event,
	sent *int64,
) error {
	if event.Sequence <= *sent {
		return nil
	}
	var payload struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return err
	}
	if err := writeTerminalMessage(ctx, socket, terminalServerMessage{
		Type:     "output",
		Data:     payload.Data,
		Sequence: event.Sequence,
	}); err != nil {
		return err
	}
	*sent = event.Sequence
	return nil
}

func writeTerminalMessage(
	ctx context.Context,
	socket *websocket.Conn,
	message terminalServerMessage,
) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return socket.Write(ctx, websocket.MessageText, encoded)
}

func (s *Server) listProviderConnections(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	connections, err := s.store.ListProviderConnections(r.Context(), account.ID)
	if err != nil {
		s.internalError(w, r, "list provider connections", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providerConnections": connections})
}

const maxAgentCredentialBytes = 64 << 10

type agentConnectionConfig struct {
	CredentialType string `json:"credentialType"`
}

func (s *Server) putAgentConnection(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	agent := strings.TrimSpace(chi.URLParam(r, "agent"))
	if _, ok := agentCredentialTypes[agent]; !ok {
		writeError(w, r, http.StatusBadRequest, "INVALID_AGENT", "The selected coding agent is not supported.")
		return
	}
	var input struct {
		CredentialType string `json:"credentialType"`
		Secret         string `json:"secret"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.CredentialType = strings.TrimSpace(input.CredentialType)
	secret := normalizeAgentCredentialSecret(input.Secret)
	input.Secret = ""
	defer clearBytes(secret)
	if !validAgentCredentialType(agent, input.CredentialType) {
		writeError(w, r, http.StatusBadRequest, "INVALID_CREDENTIAL_TYPE", "credentialType is not supported for this coding agent.")
		return
	}
	if len(secret) == 0 || len(secret) > maxAgentCredentialBytes {
		writeError(w, r, http.StatusBadRequest, "INVALID_AGENT_CREDENTIAL", "A non-empty coding-agent credential of at most 64 KiB is required.")
		return
	}
	validateCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	validationErr := s.agentCredentials.Validate(validateCtx, agent, input.CredentialType, secret)
	cancel()
	if errors.Is(validationErr, errInvalidAgentCredential) {
		writeError(
			w,
			r,
			http.StatusBadRequest,
			"AGENT_CONNECTION_INVALID",
			"The coding-agent provider rejected this credential. Generate a fresh credential and try again.",
		)
		return
	}
	if validationErr != nil {
		writeError(
			w,
			r,
			http.StatusBadGateway,
			"AGENT_CONNECTION_VALIDATION_UNAVAILABLE",
			"AO Cloud could not validate this credential with the provider.",
		)
		return
	}
	associatedData := string(account.ID) + ":" + agent + ":default"
	encrypted, nonce, err := s.secretCipher.Encrypt(secret, associatedData)
	if err != nil {
		s.internalError(w, r, "encrypt agent connection", err)
		return
	}
	config, _ := json.Marshal(agentConnectionConfig{CredentialType: input.CredentialType})
	connection, err := s.store.UpsertProviderConnection(
		r.Context(),
		account.ID,
		agent,
		"default",
		encrypted,
		nonce,
		config,
	)
	if err != nil {
		s.internalError(w, r, "save agent connection", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providerConnection": connection})
}

func (s *Server) deleteAgentConnection(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	agent := strings.TrimSpace(chi.URLParam(r, "agent"))
	if _, ok := agentCredentialTypes[agent]; !ok {
		writeError(w, r, http.StatusBadRequest, "INVALID_AGENT", "The selected coding agent is not supported.")
		return
	}
	if err := s.store.DeleteProviderConnection(r.Context(), account.ID, agent, "default"); err != nil {
		s.internalError(w, r, "delete agent connection", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var agentCredentialTypes = map[string]map[string]struct{}{
	"claude-code": {
		"oauth_token": {},
		"api_key":     {},
	},
	"codex": {
		"api_key":      {},
		"access_token": {},
	},
	"cursor": {
		"api_key": {},
	},
}

func validAgentCredentialType(agent, credentialType string) bool {
	credentialTypes, ok := agentCredentialTypes[agent]
	if !ok {
		return false
	}
	_, ok = credentialTypes[credentialType]
	return ok
}

func (s *Server) loadAgentCredential(
	ctx context.Context,
	accountID clouddomain.AccountID,
	harness string,
) (*cloudworker.AgentCredential, error) {
	if _, ok := agentCredentialTypes[harness]; !ok {
		return nil, nil
	}
	encrypted, nonce, configJSON, err := s.store.ProviderConnectionSecretByProvider(
		ctx,
		accountID,
		harness,
		"default",
	)
	if errors.Is(err, cloudpostgres.ErrProviderConnectionNotFound) {
		return nil, errAgentConnectionRequired
	}
	if err != nil {
		return nil, err
	}
	var config agentConnectionConfig
	if err := json.Unmarshal(configJSON, &config); err != nil ||
		!validAgentCredentialType(harness, config.CredentialType) {
		return nil, errAgentConnectionRequired
	}
	plaintext, err := s.secretCipher.Decrypt(
		encrypted,
		nonce,
		string(accountID)+":"+harness+":default",
	)
	if err != nil || len(plaintext) == 0 {
		clearBytes(plaintext)
		return nil, errAgentConnectionRequired
	}
	credential := &cloudworker.AgentCredential{
		Provider:       harness,
		CredentialType: config.CredentialType,
		Secret:         string(plaintext),
	}
	clearBytes(plaintext)
	return credential, nil
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

var errAgentConnectionRequired = errors.New("coding-agent connection required")

func (s *Server) listRepositories(w http.ResponseWriter, r *http.Request) {
	if s.localGitHub == nil {
		writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
		return
	}
	repositories, err := s.localGitHub.ListRepositories(r.Context())
	if err != nil {
		s.internalError(w, r, "list local GitHub repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"repositories": repositories})
}

func (s *Server) gitProxy(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:git") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:git scope is required.")
		return
	}
	if s.localGitHub == nil {
		writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
		return
	}
	launch, err := s.store.WorkerLaunchSpec(r.Context(), claims.AccountID, claims.SessionID)
	if err != nil {
		s.internalError(w, r, "authorize Git proxy", err)
		return
	}
	expectedOwner, expectedRepository, ok := cloudlocalgh.ParseRepositoryURL(launch.RepositoryURL)
	if !ok ||
		!strings.EqualFold(expectedOwner, chi.URLParam(r, "owner")) ||
		!strings.EqualFold(expectedRepository, chi.URLParam(r, "repository")) {
		writeError(w, r, http.StatusForbidden, "REPOSITORY_NOT_AUTHORIZED", "Worker is not authorized for this repository.")
		return
	}
	if err := s.localGitHub.ProxyRepository(
		r.Context(),
		w,
		r,
		expectedOwner,
		expectedRepository,
		chi.URLParam(r, "*"),
	); err != nil {
		s.internalError(w, r, "proxy GitHub repository", err)
	}
}

func (s *Server) putDaytonaConnection(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	var input struct {
		Label  string `json:"label"`
		APIKey string `json:"apiKey"`
		APIURL string `json:"apiUrl"`
		Target string `json:"target"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Label = strings.TrimSpace(input.Label)
	if input.Label == "" {
		input.Label = "personal"
	}
	input.APIKey = strings.TrimSpace(input.APIKey)
	if input.APIKey == "" {
		writeError(w, r, http.StatusBadRequest, "DAYTONA_KEY_REQUIRED", "A Daytona API key is required.")
		return
	}
	input.APIURL = strings.TrimRight(strings.TrimSpace(input.APIURL), "/")
	if input.APIURL == "" {
		input.APIURL = s.daytonaAPIURL
	}
	if input.Target == "" {
		input.Target = s.daytonaTarget
	}
	if input.Target != "us" && input.Target != "eu" {
		writeError(w, r, http.StatusBadRequest, "INVALID_DAYTONA_TARGET", "Daytona target must be us or eu.")
		return
	}
	validateCtx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := daytona.New(input.APIURL, input.APIKey, input.Target, nil).Validate(validateCtx); err != nil {
		writeError(w, r, http.StatusBadRequest, "DAYTONA_CONNECTION_INVALID", "Daytona rejected this connection.")
		return
	}
	associatedData := string(account.ID) + ":daytona:" + input.Label
	encrypted, nonce, err := s.secretCipher.Encrypt([]byte(input.APIKey), associatedData)
	if err != nil {
		s.internalError(w, r, "encrypt Daytona connection", err)
		return
	}
	config, _ := json.Marshal(map[string]string{"apiUrl": input.APIURL, "target": input.Target})
	connection, err := s.store.UpsertProviderConnection(
		r.Context(),
		account.ID,
		"daytona",
		input.Label,
		encrypted,
		nonce,
		config,
	)
	if err != nil {
		s.internalError(w, r, "save Daytona connection", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providerConnection": connection})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && origin != s.webOrigin {
			writeError(w, r, http.StatusForbidden, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed.")
			return
		}
		if origin == s.webOrigin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Last-Event-ID")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func validGitHubRepositoryURL(value string) bool {
	return strings.HasPrefix(value, "https://github.com/") &&
		len(strings.TrimPrefix(value, "https://github.com/")) > 2
}

func decodeJSON(w http.ResponseWriter, r *http.Request, output any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON.")
		return false
	}
	return true
}

func parseAfter(r *http.Request) (int64, error) {
	raw := r.URL.Query().Get("after")
	if raw == "" {
		raw = r.Header.Get("Last-Event-ID")
	}
	if raw == "" {
		return 0, nil
	}
	after, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || after < 0 {
		return 0, errors.New("invalid after")
	}
	return after, nil
}

func parseLimit(r *http.Request, maximum int) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return maximum, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 || limit > maximum {
		return 0, errors.New("invalid limit")
	}
	return limit, nil
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, event clouddomain.Event, sent *int64) error {
	if event.Sequence <= *sent {
		return nil
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return err
	}
	eventName := strings.NewReplacer("\r", "_", "\n", "_").Replace(event.Type)
	if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.Sequence, eventName, encoded); err != nil {
		return err
	}
	*sent = event.Sequence
	flusher.Flush()
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error":     http.StatusText(status),
		"code":      code,
		"message":   message,
		"requestId": middleware.GetReqID(r.Context()),
	})
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	s.log.Error("AO Cloud request failed",
		"operation", operation,
		"request_id", middleware.GetReqID(r.Context()),
		"err", err,
	)
	writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error.")
}
