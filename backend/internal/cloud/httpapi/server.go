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
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

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
	EnsureExternalAccount(context.Context, string, string, string, string) (clouddomain.Account, error)
	UpdateUserProfile(context.Context, string, cloudpostgres.UpdateUserProfileInput) (clouddomain.User, error)
	CreateOrganization(context.Context, cloudpostgres.CreateOrganizationInput) (clouddomain.UserOrganization, error)
	UpdateOrganization(context.Context, clouddomain.OrgID, cloudpostgres.UpdateOrganizationInput) (clouddomain.Organization, error)
	ListUserOrganizations(context.Context, string) ([]clouddomain.UserOrganization, error)
	GetOrgMembership(context.Context, string, clouddomain.OrgID) (clouddomain.UserOrganization, error)
	ListOrgMembers(context.Context, clouddomain.OrgID) ([]clouddomain.OrgMember, error)
	UpdateOrgMemberRole(context.Context, clouddomain.OrgID, string, string) (clouddomain.OrgMember, error)
	CreateOrgInvitation(context.Context, clouddomain.OrgID, cloudpostgres.CreateOrgInvitationInput) (clouddomain.OrgInvitation, error)
	ListOrgInvitations(context.Context, clouddomain.OrgID) ([]clouddomain.OrgInvitation, error)
	ListUserInvitations(context.Context, string, string) ([]clouddomain.OrgInvitation, error)
	AcceptOrgInvitation(context.Context, string, string, string) (clouddomain.OrgMembership, error)
	DeclineOrgInvitation(context.Context, string, string, string) error
	RevokeOrgInvitation(context.Context, clouddomain.OrgID, string) error
	CreateProject(context.Context, clouddomain.AccountID, cloudpostgres.CreateProjectInput) (clouddomain.Project, error)
	ListProjects(context.Context, clouddomain.AccountID) ([]clouddomain.Project, error)
	GetProject(context.Context, clouddomain.AccountID, clouddomain.ProjectID) (clouddomain.Project, error)
	CreateSession(context.Context, clouddomain.AccountID, cloudpostgres.CreateSessionInput) (cloudpostgres.CreateSessionResult, error)
	ListSessions(context.Context, clouddomain.AccountID) ([]clouddomain.Session, error)
	GetSession(context.Context, clouddomain.AccountID, clouddomain.SessionID) (clouddomain.Session, error)
	GetActiveTurn(context.Context, clouddomain.AccountID, clouddomain.SessionID) (*clouddomain.Turn, error)
	GetLatestTurn(context.Context, clouddomain.AccountID, clouddomain.SessionID) (*clouddomain.Turn, error)
	TransitionActiveTurn(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, string) (*clouddomain.Turn, error)
	ClaimActiveTurn(context.Context, clouddomain.AccountID, clouddomain.SessionID, int64, int64) error
	PrepareActiveTurnForWorker(context.Context, clouddomain.AccountID, clouddomain.SessionID, int64) (int64, error)
	GetSandbox(context.Context, clouddomain.AccountID, clouddomain.SessionID) (clouddomain.Sandbox, error)
	SetSandboxDesiredState(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) error
	ConsumeAccessTicket(context.Context, string, string) (cloudpostgres.ConsumedTicket, error)
	RedeemWorkerBootstrapTicket(context.Context, string) (cloudpostgres.ConsumedTicket, error)
	RegisterWorkerBootstrap(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, string, int64, []string) error
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
	UpsertIssueSnapshot(context.Context, clouddomain.AccountID, clouddomain.Issue) (clouddomain.Issue, error)
	LinkSessionIssue(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) error
	ClaimPullRequest(context.Context, clouddomain.AccountID, clouddomain.PRClaim) (clouddomain.PRClaim, error)
	MarkReviewThreadResolved(context.Context, clouddomain.AccountID, clouddomain.SessionID, string) error
}

// Server serves the authenticated AO Cloud HTTP and WebSocket APIs.
type Server struct {
	store            store
	events           *cloudevents.Service
	auth             cloudauth.Authenticator
	localAuth        *cloudauth.LocalAuthenticator
	workerTokens     *cloudworker.TokenManager
	secretCipher     *cloudsecrets.Cipher
	agentCredentials *agentCredentialValidator
	sandboxProvider  string
	daytonaAPIURL    string
	daytonaTarget    string
	workerHub        *cloudworkerhub.Hub
	workerRPC        *workerRPCBroker
	previewTokens    *previewTokenStore
	workerReplayWait time.Duration
	workerWriteWait  time.Duration
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
	auth cloudauth.Authenticator,
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
	localAuth, _ := auth.(*cloudauth.LocalAuthenticator)
	server := &Server{
		store:            store,
		events:           events,
		auth:             auth,
		localAuth:        localAuth,
		workerTokens:     workerTokens,
		secretCipher:     secretCipher,
		agentCredentials: newAgentCredentialValidator(nil),
		sandboxProvider:  sandboxProvider,
		daytonaAPIURL:    strings.TrimRight(daytonaAPIURL, "/"),
		daytonaTarget:    daytonaTarget,
		workerHub:        workerHub,
		workerRPC:        newWorkerRPCBroker(),
		previewTokens:    newPreviewTokenStore(),
		workerReplayWait: 20 * time.Second,
		workerWriteWait:  10 * time.Second,
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
type orgContextKey struct{}

func accountFromContext(ctx context.Context) (clouddomain.Account, bool) {
	account, ok := ctx.Value(accountContextKey{}).(clouddomain.Account)
	return account, ok
}

func orgFromContext(ctx context.Context) (clouddomain.UserOrganization, bool) {
	org, ok := ctx.Value(orgContextKey{}).(clouddomain.UserOrganization)
	return org, ok
}

func tenantAccountIDFromContext(ctx context.Context) clouddomain.AccountID {
	if org, ok := orgFromContext(ctx); ok {
		return clouddomain.AccountID(org.Organization.ID)
	}
	account, _ := accountFromContext(ctx)
	return account.ID
}

func (s *Server) routes() http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Recoverer)
	router.Use(s.requestLogger)
	router.Use(s.cors)
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "ao-cloud"})
	})
	router.Get("/readyz", s.ready)

	router.Route("/api/cloud/v1", func(api chi.Router) {
		if s.localAuth != nil {
			api.Post("/auth/signup", s.localSignUp)
			api.Post("/auth/login", s.localLogin)
			api.With(s.localAuth.Middleware).Post("/auth/logout", s.localLogout)
		}
		api.Post("/worker/bootstrap", s.workerBootstrap)
		api.Get("/terminal", s.terminalSocket)
		api.HandleFunc("/preview/{token}/*", s.workspacePreviewProxy)
		api.Group(func(worker chi.Router) {
			worker.Use(s.workerAuth)
			worker.Post("/worker/heartbeat", s.workerHeartbeat)
			worker.Post("/worker/events", s.workerEvent)
			worker.Post("/worker/workspace-response", s.workerWorkspaceResponse)
			worker.Get("/worker/connect", s.workerConnect)
			worker.Get("/worker/orchestrate/sessions", s.workerListSessions)
			worker.Post("/worker/orchestrate/sessions", s.workerCreateSession)
			worker.Delete("/worker/orchestrate/sessions/{sessionId}", s.workerKillSession)
			worker.Post("/worker/orchestrate/sessions/{sessionId}/messages", s.workerSendMessage)
			worker.Post("/worker/orchestrate/sessions/{sessionId}/claim-pr", s.workerClaimPullRequest)
			worker.Post("/worker/orchestrate/sessions/{sessionId}/merge-pr", s.workerMergePullRequest)
			worker.Post("/worker/orchestrate/sessions/{sessionId}/review-threads/{threadId}/resolve", s.workerResolveReviewThread)
			worker.Get("/worker/orchestrate/sessions/{sessionId}/inspection", s.workerInspectSession)
			worker.Post("/worker/blocker", s.workerReportBlocker)
			worker.Post("/worker/scm/claim-pr", s.workerClaimOwnPullRequest)
			worker.Handle("/git/{owner}/{repository}.git/*", http.HandlerFunc(s.gitProxy))
		})

		api.Group(func(protected chi.Router) {
			protected.Use(s.auth.Middleware)
			protected.Use(s.ensureAccount)
			protected.Get("/me", s.me)
			protected.Patch("/me", s.updateMe)
			protected.Get("/orgs", s.listOrgs)
			protected.Post("/orgs", s.createOrg)
			protected.Get("/invitations", s.listMyInvitations)
			protected.Post("/invitations/{invitationId}/accept", s.acceptInvitation)
			protected.Post("/invitations/{invitationId}/decline", s.declineInvitation)
			// Compatibility aliases for existing local tests/tools. The browser UI
			// uses the explicit /orgs/{orgId}/... routes below.
			protected.Get("/projects", s.listProjects)
			protected.Post("/projects", s.createProject)
			protected.Get("/sessions", s.listSessions)
			protected.Post("/sessions", s.createSession)
			protected.Get("/sessions/{sessionId}", s.getSession)
			protected.Get("/sessions/{sessionId}/active-turn", s.activeTurn)
			protected.Post("/sessions/{sessionId}/desired-state", s.setDesiredState)
			protected.Get("/sessions/{sessionId}/chat-events", s.chatEvents)
			protected.Post("/sessions/{sessionId}/messages", s.sendMessage)
			protected.Post("/sessions/{sessionId}/interrupt", s.interruptSession)
			protected.Get("/sessions/{sessionId}/events", s.streamEvents)
			protected.Get("/sessions/{sessionId}/scm", s.sessionSCM)
			protected.Get("/sessions/{sessionId}/workspace/files", s.workspaceFiles)
			protected.Get("/sessions/{sessionId}/workspace/file", s.workspaceFile)
			protected.Get("/sessions/{sessionId}/workspace/diff", s.workspaceDiff)
			protected.Post("/sessions/{sessionId}/workspace/preview", s.workspacePreview)
			protected.Post("/sessions/{sessionId}/workspace/preview-ticket", s.issueWorkspacePreview)
			protected.Post("/sessions/{sessionId}/workspace/file-preview-ticket", s.issueWorkspaceFilePreview)
			protected.Post("/sessions/{sessionId}/terminal-ticket", s.issueTerminalTicket)
			protected.Get("/provider-connections", s.listProviderConnections)
			protected.Put("/provider-connections/daytona", s.putDaytonaConnection)
			protected.Put("/provider-connections/agents/{agent}", s.putAgentConnection)
			protected.Delete("/provider-connections/agents/{agent}", s.deleteAgentConnection)
			protected.Get("/repositories", s.listRepositories)
			protected.Route("/orgs/{orgId}", func(org chi.Router) {
				org.Use(s.requireOrg)
				org.Patch("/", s.updateOrg)
				org.Get("/members", s.listOrgMembers)
				org.With(s.requireOrgRole("admin")).Patch("/members/{userId}", s.updateOrgMemberRole)
				org.Get("/invitations", s.listOrgInvitations)
				org.Post("/invitations", s.createOrgInvitation)
				org.Post("/invitations/{invitationId}/revoke", s.revokeInvitation)
				org.Get("/projects", s.listProjects)
				org.With(s.requireOrgRole("member")).Post("/projects", s.createProject)
				org.Get("/sessions", s.listSessions)
				org.With(s.requireOrgRole("member")).Post("/sessions", s.createSession)
				org.Get("/sessions/{sessionId}", s.getSession)
				org.Get("/sessions/{sessionId}/active-turn", s.activeTurn)
				org.With(s.requireOrgRole("member")).Post("/sessions/{sessionId}/desired-state", s.setDesiredState)
				org.Get("/sessions/{sessionId}/chat-events", s.chatEvents)
				org.With(s.requireOrgRole("member")).Post("/sessions/{sessionId}/messages", s.sendMessage)
				org.With(s.requireOrgRole("member")).Post("/sessions/{sessionId}/interrupt", s.interruptSession)
				org.Get("/sessions/{sessionId}/events", s.streamEvents)
				org.Get("/sessions/{sessionId}/scm", s.sessionSCM)
				org.Get("/sessions/{sessionId}/workspace/files", s.workspaceFiles)
				org.Get("/sessions/{sessionId}/workspace/file", s.workspaceFile)
				org.Get("/sessions/{sessionId}/workspace/diff", s.workspaceDiff)
				org.Post("/sessions/{sessionId}/workspace/preview", s.workspacePreview)
				org.Post("/sessions/{sessionId}/workspace/preview-ticket", s.issueWorkspacePreview)
				org.Post("/sessions/{sessionId}/workspace/file-preview-ticket", s.issueWorkspaceFilePreview)
				org.Post("/sessions/{sessionId}/terminal-ticket", s.issueTerminalTicket)
				org.Get("/provider-connections", s.listProviderConnections)
				org.With(s.requireOrgRole("admin")).Put("/provider-connections/daytona", s.putDaytonaConnection)
				org.With(s.requireOrgRole("admin")).Put("/provider-connections/agents/{agent}", s.putAgentConnection)
				org.With(s.requireOrgRole("admin")).Delete("/provider-connections/agents/{agent}", s.deleteAgentConnection)
				org.Get("/repositories", s.listRepositories)
			})
		})
	})
	return router
}

func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startedAt := time.Now()
		wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(wrapped, r)
		status := wrapped.Status()
		if status == 0 {
			status = http.StatusOK
		}
		if status < http.StatusBadRequest && quietCloudRequest(r.URL.Path) {
			return
		}
		route := ""
		if routeContext := chi.RouteContext(r.Context()); routeContext != nil {
			route = routeContext.RoutePattern()
		}
		logPath := r.URL.Path
		if strings.HasPrefix(logPath, "/api/cloud/v1/preview/") {
			logPath = "/api/cloud/v1/preview/[redacted]"
		}
		s.log.Info("AO Cloud request completed",
			"request_id", middleware.GetReqID(r.Context()),
			"method", r.Method,
			"path", logPath,
			"route", route,
			"status", status,
			"bytes", wrapped.BytesWritten(),
			"duration_ms", time.Since(startedAt).Milliseconds(),
		)
	})
}

func quietCloudRequest(path string) bool {
	if strings.HasPrefix(path, "/api/cloud/v1/preview/") {
		return true
	}
	switch path {
	case "/healthz", "/readyz",
		"/api/cloud/v1/worker/heartbeat",
		"/api/cloud/v1/worker/events":
		return true
	default:
		return false
	}
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
		account, err := s.ensurePrincipalAccount(r.Context(), &principal)
		if err != nil {
			s.internalError(w, r, "ensure account", err)
			return
		}
		ctx := cloudauth.ContextWithPrincipal(r.Context(), principal)
		ctx = context.WithValue(ctx, accountContextKey{}, account)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) ensurePrincipalAccount(
	ctx context.Context,
	principal *cloudauth.Principal,
) (clouddomain.Account, error) {
	if principal.AuthProvider != "" && principal.AuthProvider != "local" {
		account, err := s.store.EnsureExternalAccount(
			ctx,
			principal.AuthProvider,
			principal.ExternalUserID,
			principal.Email,
			principal.DisplayName,
		)
		if err != nil {
			return clouddomain.Account{}, err
		}
		principal.UserID = account.OwnerUserID
		return account, nil
	}
	return s.store.EnsureAccount(ctx, principal.UserID, principal.DisplayName)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	account, _ := accountFromContext(r.Context())
	organizations, err := s.store.ListUserOrganizations(r.Context(), principal.UserID)
	if err != nil {
		s.internalError(w, r, "list user organizations", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{
			"id":          principal.UserID,
			"email":       principal.Email,
			"displayName": principal.DisplayName,
		},
		"account":         account,
		"organizations":   organizations,
		"sandboxProvider": s.sandboxProvider,
	})
}

func (s *Server) updateMe(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	var input struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_PROFILE", "Display name is required.")
		return
	}
	if len(input.DisplayName) > 120 {
		writeError(w, r, http.StatusBadRequest, "INVALID_PROFILE", "Display name must be at most 120 characters.")
		return
	}
	user, err := s.store.UpdateUserProfile(r.Context(), principal.UserID, cloudpostgres.UpdateUserProfileInput{
		DisplayName: input.DisplayName,
	})
	if errors.Is(err, cloudpostgres.ErrInvalidUserProfile) {
		writeError(w, r, http.StatusBadRequest, "INVALID_PROFILE", "Display name is required.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrCloudUserNotFound) {
		writeError(w, r, http.StatusNotFound, "USER_NOT_FOUND", "The current user does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "update user profile", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) listOrgs(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	organizations, err := s.store.ListUserOrganizations(r.Context(), principal.UserID)
	if err != nil {
		s.internalError(w, r, "list user organizations", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"organizations": organizations})
}

func (s *Server) createOrg(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	var input struct {
		DisplayName string `json:"displayName"`
		Kind        string `json:"kind"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	org, err := s.store.CreateOrganization(r.Context(), cloudpostgres.CreateOrganizationInput{
		UserID:      principal.UserID,
		DisplayName: input.DisplayName,
		Kind:        input.Kind,
	})
	if errors.Is(err, cloudpostgres.ErrInvalidOrganization) {
		writeError(w, r, http.StatusBadRequest, "INVALID_ORG", "Organization name is required.")
		return
	}
	if err != nil {
		s.internalError(w, r, "create organization", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"organization": org})
}

func (s *Server) updateOrg(w http.ResponseWriter, r *http.Request) {
	org, _ := orgFromContext(r.Context())
	if !orgRoleAtLeast(org.Membership.Role, "admin") {
		writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Only organization admins can update organization settings.")
		return
	}
	var input struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	updated, err := s.store.UpdateOrganization(r.Context(), org.Organization.ID, cloudpostgres.UpdateOrganizationInput{
		DisplayName: input.DisplayName,
	})
	if errors.Is(err, cloudpostgres.ErrInvalidOrganization) {
		writeError(w, r, http.StatusBadRequest, "INVALID_ORG", "Organization name is required.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrOrganizationNotFound) {
		writeError(w, r, http.StatusNotFound, "ORG_NOT_FOUND", "The organization does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "update organization", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"organization": updated})
}

func (s *Server) listOrgMembers(w http.ResponseWriter, r *http.Request) {
	org, _ := orgFromContext(r.Context())
	members, err := s.store.ListOrgMembers(r.Context(), org.Organization.ID)
	if err != nil {
		s.internalError(w, r, "list org members", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (s *Server) updateOrgMemberRole(w http.ResponseWriter, r *http.Request) {
	org, _ := orgFromContext(r.Context())
	targetUserID := strings.TrimSpace(chi.URLParam(r, "userId"))
	if targetUserID == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_MEMBER", "Member user id is required.")
		return
	}
	var input struct {
		Role string `json:"role"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Role = strings.TrimSpace(input.Role)
	if !validOrgRole(input.Role) {
		writeError(w, r, http.StatusBadRequest, "INVALID_ROLE", "Role must be owner, admin, member, or viewer.")
		return
	}
	if input.Role == "owner" && org.Membership.Role != "owner" {
		writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Only organization owners can grant owner role.")
		return
	}
	member, err := s.store.UpdateOrgMemberRole(r.Context(), org.Organization.ID, targetUserID, input.Role)
	if errors.Is(err, cloudpostgres.ErrOrgMembershipNotFound) {
		writeError(w, r, http.StatusNotFound, "MEMBER_NOT_FOUND", "The organization member does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "update org member role", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) listMyInvitations(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	invitations, err := s.store.ListUserInvitations(r.Context(), principal.UserID, principal.Email)
	if err != nil {
		s.internalError(w, r, "list user invitations", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": invitations})
}

func (s *Server) listOrgInvitations(w http.ResponseWriter, r *http.Request) {
	org, _ := orgFromContext(r.Context())
	if !orgRoleAtLeast(org.Membership.Role, "admin") {
		writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Only organization admins can view invitations.")
		return
	}
	invitations, err := s.store.ListOrgInvitations(r.Context(), org.Organization.ID)
	if err != nil {
		s.internalError(w, r, "list org invitations", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": invitations})
}

func (s *Server) createOrgInvitation(w http.ResponseWriter, r *http.Request) {
	org, _ := orgFromContext(r.Context())
	if !orgRoleAtLeast(org.Membership.Role, "admin") {
		writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Only organization admins can invite people.")
		return
	}
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	var input struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	email, err := normalizeCloudEmail(input.Email)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_EMAIL", "A valid invite email is required.")
		return
	}
	role := strings.TrimSpace(input.Role)
	if role == "" {
		role = "member"
	}
	if !validOrgRole(role) || role == "owner" {
		writeError(w, r, http.StatusBadRequest, "INVALID_ROLE", "Invite role must be admin, member, or viewer.")
		return
	}
	invitation, err := s.store.CreateOrgInvitation(
		r.Context(),
		org.Organization.ID,
		cloudpostgres.CreateOrgInvitationInput{
			Email:           email,
			InvitedByUserID: clouddomain.UserID(principal.UserID),
			Role:            role,
		},
	)
	if errors.Is(err, cloudpostgres.ErrOrgInvitationExists) {
		writeError(w, r, http.StatusConflict, "INVITATION_EXISTS", "This email already has a pending invitation.")
		return
	}
	if err != nil {
		s.internalError(w, r, "create org invitation", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"invitation": invitation})
}

func (s *Server) acceptInvitation(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	membership, err := s.store.AcceptOrgInvitation(
		r.Context(),
		principal.UserID,
		principal.Email,
		chi.URLParam(r, "invitationId"),
	)
	if errors.Is(err, cloudpostgres.ErrOrgInvitationNotFound) {
		writeError(w, r, http.StatusNotFound, "INVITATION_NOT_FOUND", "The invitation is no longer available.")
		return
	}
	if err != nil {
		s.internalError(w, r, "accept org invitation", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"membership": membership})
}

func (s *Server) declineInvitation(w http.ResponseWriter, r *http.Request) {
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	err := s.store.DeclineOrgInvitation(
		r.Context(),
		principal.UserID,
		principal.Email,
		chi.URLParam(r, "invitationId"),
	)
	if errors.Is(err, cloudpostgres.ErrOrgInvitationNotFound) {
		writeError(w, r, http.StatusNotFound, "INVITATION_NOT_FOUND", "The invitation is no longer available.")
		return
	}
	if err != nil {
		s.internalError(w, r, "decline org invitation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) revokeInvitation(w http.ResponseWriter, r *http.Request) {
	org, _ := orgFromContext(r.Context())
	if !orgRoleAtLeast(org.Membership.Role, "admin") {
		writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Only organization admins can revoke invitations.")
		return
	}
	err := s.store.RevokeOrgInvitation(r.Context(), org.Organization.ID, chi.URLParam(r, "invitationId"))
	if errors.Is(err, cloudpostgres.ErrOrgInvitationNotFound) {
		writeError(w, r, http.StatusNotFound, "INVITATION_NOT_FOUND", "The invitation is no longer available.")
		return
	}
	if err != nil {
		s.internalError(w, r, "revoke org invitation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) requireOrg(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := cloudauth.PrincipalFromContext(r.Context())
		if !ok {
			writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
			return
		}
		orgID := clouddomain.OrgID(strings.TrimSpace(chi.URLParam(r, "orgId")))
		if orgID == "" {
			writeError(w, r, http.StatusBadRequest, "ORG_REQUIRED", "An organization is required.")
			return
		}
		org, err := s.store.GetOrgMembership(r.Context(), principal.UserID, orgID)
		if errors.Is(err, cloudpostgres.ErrOrgMembershipNotFound) {
			writeError(w, r, http.StatusForbidden, "ORG_FORBIDDEN", "You do not have access to this organization.")
			return
		}
		if err != nil {
			s.internalError(w, r, "authorize organization", err)
			return
		}
		account := clouddomain.Account{
			ID:          clouddomain.AccountID(org.Organization.ID),
			OwnerUserID: principal.UserID,
			DisplayName: org.Organization.DisplayName,
			CreatedAt:   org.Organization.CreatedAt,
			UpdatedAt:   org.Organization.UpdatedAt,
		}
		ctx := context.WithValue(r.Context(), orgContextKey{}, org)
		ctx = context.WithValue(ctx, accountContextKey{}, account)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) requireOrgRole(required string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			org, ok := orgFromContext(r.Context())
			if !ok || !orgRoleAtLeast(org.Membership.Role, required) {
				writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Your organization role cannot perform this action.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func normalizeCloudEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return "", errors.New("invalid email")
	}
	return email, nil
}

func validOrgRole(role string) bool {
	switch role {
	case "owner", "admin", "member", "viewer":
		return true
	default:
		return false
	}
}

func orgRoleAtLeast(actual, required string) bool {
	return orgRoleRank(actual) >= orgRoleRank(required)
}

func orgRoleRank(role string) int {
	switch role {
	case "owner":
		return 3
	case "admin":
		return 2
	case "member":
		return 1
	case "viewer":
		return 0
	default:
		return -1
	}
}

func (s *Server) localSignUp(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	principal, err := s.localAuth.SignUp(r.Context(), input.Email, input.Password, input.DisplayName)
	if errors.Is(err, cloudpostgres.ErrLocalUserExists) {
		writeError(w, r, http.StatusConflict, "EMAIL_EXISTS", "An account with this email already exists.")
		return
	}
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_CREDENTIALS", err.Error())
		return
	}
	writeLocalAuthResponse(w, http.StatusCreated, principal)
}

func (s *Server) localLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	principal, err := s.localAuth.Login(r.Context(), input.Email, input.Password)
	if errors.Is(err, cloudauth.ErrUnauthenticated) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Email or password is incorrect.")
		return
	}
	if err != nil {
		s.internalError(w, r, "local login", err)
		return
	}
	writeLocalAuthResponse(w, http.StatusOK, principal)
}

func (s *Server) localLogout(w http.ResponseWriter, r *http.Request) {
	principal, ok := cloudauth.PrincipalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
		return
	}
	if err := s.localAuth.Logout(r.Context(), principal.AccessToken); err != nil {
		s.internalError(w, r, "local logout", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeLocalAuthResponse(w http.ResponseWriter, status int, principal cloudauth.Principal) {
	writeJSON(w, status, map[string]any{
		"accessToken": principal.AccessToken,
		"tokenType":   "Bearer",
		"user": map[string]string{
			"id":          principal.UserID,
			"email":       principal.Email,
			"displayName": principal.DisplayName,
		},
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
	agentConnected, err := s.hasAgentConnection(r.Context(), account.ID)
	if err != nil {
		s.internalError(w, r, "check agent connection", err)
		return
	}
	if !agentConnected {
		writeError(
			w,
			r,
			http.StatusBadRequest,
			"AGENT_CONNECTION_REQUIRED",
			"Connect a coding agent before creating a cloud project.",
		)
		return
	}
	project, err := s.store.CreateProject(r.Context(), account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   input.DisplayName,
		RepositoryURL: input.RepositoryURL,
		DefaultBranch: input.DefaultBranch,
		Config:        input.Config,
	})
	if errors.Is(err, cloudpostgres.ErrProjectExists) {
		writeError(w, r, http.StatusConflict, "PROJECT_EXISTS", "This repository is already registered.")
		return
	}
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
	defaultResource := clouddomain.DefaultResourceProfile()
	if input.Resource == (clouddomain.ResourceProfile{}) {
		input.Resource = defaultResource
	}
	if input.Resource != defaultResource {
		writeError(
			w,
			r,
			http.StatusBadRequest,
			"INVALID_RESOURCE_PROFILE",
			"Cloud V1 requires 4 CPU, 8 GiB memory, and 10 GiB disk.",
		)
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
	if errors.Is(err, cloudpostgres.ErrIdempotencyConflict) {
		writeError(w, r, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another command.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrProjectNotFound) {
		writeError(w, r, http.StatusNotFound, "PROJECT_NOT_FOUND", "The cloud project does not exist.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrProviderConnectionNotFound) {
		writeError(w, r, http.StatusBadRequest, "PROVIDER_CONNECTION_NOT_FOUND", "The selected Daytona connection does not exist.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrActiveOrchestrator) {
		writeError(w, r, http.StatusConflict, "ORCHESTRATOR_EXISTS", "This project already has an active orchestrator.")
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

func (s *Server) activeTurn(w http.ResponseWriter, r *http.Request) {
	_, session, ok := s.authorizedSession(w, r, "read active turn")
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"turn": session.ActiveTurn})
}

func (s *Server) chatEvents(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	account.ID = tenantAccountIDFromContext(r.Context())
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
	account.ID = tenantAccountIDFromContext(r.Context())
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
	if errors.Is(err, cloudpostgres.ErrActiveTurn) {
		writeError(w, r, http.StatusConflict, "TURN_ACTIVE", "The cloud session already has a response in progress.")
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
	s.log.Info("cloud turn queued",
		"request_id", middleware.GetReqID(r.Context()),
		"session_id", sessionID,
		"message_sequence", event.Sequence,
	)
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
	if _, err := s.store.TransitionActiveTurn(ctx, accountID, sessionID, "provisioning", ""); err != nil {
		return err
	}
	return s.store.UpdateSessionActivity(ctx, accountID, sessionID, "active")
}

func (s *Server) interruptSession(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	account.ID = tenantAccountIDFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	session, err := s.store.GetSession(r.Context(), account.ID, sessionID)
	if err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize cloud interrupt", err)
		return
	}
	payloadData := map[string]string{"source": "browser"}
	if session.ActiveTurn != nil {
		payloadData["turnId"] = session.ActiveTurn.ID
	}
	payload, _ := json.Marshal(payloadData)
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
	nextState := "cancel_requested"
	if !session.RuntimeConnected {
		nextState = "completed"
	}
	if _, err := s.store.TransitionActiveTurn(
		r.Context(),
		account.ID,
		sessionID,
		nextState,
		"",
	); err != nil {
		s.internalError(w, r, "request turn cancellation", err)
		return
	}
	if !session.RuntimeConnected {
		if err := s.store.UpdateSessionActivity(r.Context(), account.ID, sessionID, "idle"); err != nil {
			s.internalError(w, r, "update offline interrupt activity", err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
		return
	}
	if err := s.store.UpdateSessionActivity(r.Context(), account.ID, sessionID, "active"); err != nil {
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
	account, session, ok := s.authorizedSession(w, r, "read cloud SCM")
	if !ok {
		return
	}
	scm, err := s.store.SessionSCM(r.Context(), account.ID, session.ID)
	if err != nil {
		s.internalError(w, r, "read cloud SCM", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scm": scm})
}

func (s *Server) authorizedSession(
	w http.ResponseWriter,
	r *http.Request,
	action string,
) (clouddomain.Account, clouddomain.Session, bool) {
	account, _ := accountFromContext(r.Context())
	account.ID = tenantAccountIDFromContext(r.Context())
	session, err := s.store.GetSession(
		r.Context(),
		account.ID,
		clouddomain.SessionID(chi.URLParam(r, "sessionId")),
	)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
		return clouddomain.Account{}, clouddomain.Session{}, false
	}
	if err != nil {
		s.internalError(w, r, action, err)
		return clouddomain.Account{}, clouddomain.Session{}, false
	}
	return account, session, true
}

func (s *Server) setDesiredState(w http.ResponseWriter, r *http.Request) {
	account, session, ok := s.authorizedSession(w, r, "set cloud session desired state")
	if !ok {
		return
	}
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
	if input.State == "deleted" && session.Kind != "worker" {
		writeError(w, r, http.StatusConflict, "PROJECT_DELETE_REQUIRED", "Remove the project to delete its orchestrator.")
		return
	}
	sessionID := session.ID
	if err := s.store.SetSandboxDesiredState(r.Context(), account.ID, sessionID, input.State); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "set desired state", err)
		return
	}
	if input.State == "deleted" {
		if _, err := s.store.TransitionActiveTurn(
			r.Context(),
			account.ID,
			sessionID,
			"failed",
			"Worker machine deleted.",
		); err != nil {
			s.internalError(w, r, "finish deleted worker turn", err)
			return
		}
		if err := s.store.UpdateSessionActivity(r.Context(), account.ID, sessionID, "idle"); err != nil {
			s.internalError(w, r, "reset deleted worker activity", err)
			return
		}
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
	account.ID = tenantAccountIDFromContext(r.Context())
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
	ticket, err := s.store.RedeemWorkerBootstrapTicket(
		r.Context(),
		input.BootstrapToken,
	)
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
	localGitHubToken := ""
	if s.sandboxProvider == "docker" && s.localGitHub != nil {
		localGitHubToken, err = s.localGitHub.Token(r.Context())
		if err != nil {
			s.internalError(w, r, "load local GitHub credential for worker", err)
			return
		}
	}
	epoch := ticket.WorkerEpoch
	if epoch <= 0 {
		writeError(
			w,
			r,
			http.StatusInternalServerError,
			"BOOTSTRAP_FAILED",
			"Worker bootstrap identity was not assigned.",
		)
		return
	}
	workerID := cloudworker.NextWorkerID(ticket.SessionID, epoch)
	if err := s.store.RegisterWorkerBootstrap(
		r.Context(),
		ticket.AccountID,
		ticket.SessionID,
		workerID,
		input.Version,
		epoch,
		input.Capabilities,
	); err != nil {
		s.internalError(w, r, "register worker bootstrap", err)
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
		WorkerToken:      token,
		WorkerID:         workerID,
		Epoch:            epoch,
		ExpiresIn:        900,
		SessionID:        string(ticket.SessionID),
		Launch:           launchSpec,
		AgentCredential:  agentCredential,
		LocalGitHubToken: localGitHubToken,
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
		IssueNumber int    `json:"issueNumber"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName != "" && len(input.DisplayName) > 200 {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION", "displayName must be at most 200 characters.")
		return
	}
	if input.IssueNumber < 0 {
		writeError(w, r, http.StatusBadRequest, "INVALID_ISSUE", "issueNumber must be a positive integer.")
		return
	}
	var issue *cloudlocalgh.Issue
	if input.IssueNumber > 0 {
		if s.localGitHub == nil {
			writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
			return
		}
		project, err := s.store.GetProject(r.Context(), claims.AccountID, parent.ProjectID)
		if err != nil {
			s.internalError(w, r, "load orchestrator project for issue", err)
			return
		}
		resolved, err := s.localGitHub.GetIssue(r.Context(), project.RepositoryURL, input.IssueNumber)
		if err != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_ISSUE", "The GitHub issue could not be found in this project.")
			return
		}
		issue = &resolved
		if input.DisplayName == "" {
			input.DisplayName = fmt.Sprintf("issue-%d", resolved.Number)
		}
		if strings.TrimSpace(input.Prompt) == "" {
			input.Prompt = issuePrompt(resolved)
		}
	}
	if input.DisplayName == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION", "displayName is required unless issueNumber is provided.")
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
	if issue != nil {
		snapshot, err := s.store.UpsertIssueSnapshot(r.Context(), claims.AccountID, clouddomain.Issue{
			ProjectID:  parent.ProjectID,
			Provider:   "github",
			Repository: issue.Repository,
			Number:     issue.Number,
			URL:        issue.URL,
			Title:      issue.Title,
			Body:       issue.Body,
			State:      issue.State,
			ObservedAt: time.Now().UTC(),
		})
		if err != nil {
			s.internalError(w, r, "store GitHub issue snapshot", err)
			return
		}
		if err := s.store.LinkSessionIssue(r.Context(), claims.AccountID, result.Session.ID, snapshot.ID); err != nil {
			s.internalError(w, r, "link worker to GitHub issue", err)
			return
		}
	}
	status := http.StatusCreated
	if !result.Created {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func issuePrompt(issue cloudlocalgh.Issue) string {
	prompt := fmt.Sprintf("Implement GitHub issue #%d: %s", issue.Number, issue.Title)
	if body := strings.TrimSpace(issue.Body); body != "" {
		prompt += "\n\n" + body
	}
	return prompt
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

func (s *Server) workerClaimPullRequest(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	targetID, validTarget := sessionIDParam(w, r)
	if !validTarget {
		return
	}
	target, err := s.store.GetSession(r.Context(), claims.AccountID, targetID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) ||
		err == nil && (target.ProjectID != parent.ProjectID || target.Kind != "worker") {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The project worker does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "authorize pull request claim", err)
		return
	}
	if s.localGitHub == nil {
		writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
		return
	}
	var input struct {
		Reference string `json:"reference"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	project, err := s.store.GetProject(r.Context(), claims.AccountID, parent.ProjectID)
	if err != nil {
		s.internalError(w, r, "load project for pull request claim", err)
		return
	}
	pull, err := s.localGitHub.GetPullRequest(r.Context(), project.RepositoryURL, input.Reference)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_PULL_REQUEST", "The pull request must belong to this project.")
		return
	}
	claim, err := s.store.ClaimPullRequest(r.Context(), claims.AccountID, clouddomain.PRClaim{
		SessionID:  target.ID,
		Provider:   "github",
		Repository: pull.Repository,
		Number:     pull.Number,
		URL:        pull.URL,
	})
	if errors.Is(err, cloudpostgres.ErrPRClaimed) {
		writeError(w, r, http.StatusConflict, "PR_ALREADY_CLAIMED", "Another active worker already owns this pull request.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		writeError(w, r, http.StatusConflict, "WORKER_INACTIVE", "Only an active worker can claim a pull request.")
		return
	}
	if err != nil {
		s.internalError(w, r, "claim pull request", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"claim": claim})
}

func (s *Server) workerMergePullRequest(w http.ResponseWriter, r *http.Request) {
	claims, parent, target, ok := s.authorizedProjectWorker(w, r, "authorize pull request merge")
	if !ok {
		return
	}
	if s.localGitHub == nil {
		writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
		return
	}
	scm, err := s.store.SessionSCM(r.Context(), claims.AccountID, target.ID)
	if err != nil {
		s.internalError(w, r, "load pull request for merge", err)
		return
	}
	if scm == nil || scm.PullRequest.Number <= 0 {
		writeError(w, r, http.StatusConflict, "PULL_REQUEST_REQUIRED", "The worker does not have an observed pull request.")
		return
	}
	project, err := s.store.GetProject(r.Context(), claims.AccountID, parent.ProjectID)
	if err != nil {
		s.internalError(w, r, "load project for pull request merge", err)
		return
	}
	pull, err := s.localGitHub.MergePullRequest(r.Context(), project.RepositoryURL, scm.PullRequest.Number)
	if err != nil {
		writeError(w, r, http.StatusBadGateway, "PULL_REQUEST_MERGE_FAILED", err.Error())
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"repository": pull.Repository,
		"number":     pull.Number,
		"url":        pull.URL,
		"source":     "orchestrator",
	})
	if _, err := s.events.Append(r.Context(), claims.AccountID, target.ID, "repository.pull_request_merged", payload); err != nil {
		s.internalError(w, r, "append pull request merge event", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pullRequest": pull})
}

func (s *Server) workerResolveReviewThread(w http.ResponseWriter, r *http.Request) {
	claims, _, target, ok := s.authorizedProjectWorker(w, r, "authorize review thread resolution")
	if !ok {
		return
	}
	if s.localGitHub == nil {
		writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
		return
	}
	threadID := strings.TrimSpace(chi.URLParam(r, "threadId"))
	if threadID == "" || len(threadID) > 300 {
		writeError(w, r, http.StatusBadRequest, "INVALID_REVIEW_THREAD", "review thread id is invalid.")
		return
	}
	scm, err := s.store.SessionSCM(r.Context(), claims.AccountID, target.ID)
	if err != nil {
		s.internalError(w, r, "load review threads", err)
		return
	}
	if scm == nil || !sessionHasReviewThread(scm.ReviewThreads, threadID) {
		writeError(w, r, http.StatusNotFound, "REVIEW_THREAD_NOT_FOUND", "The review thread does not belong to this worker.")
		return
	}
	if err := s.localGitHub.ResolveReviewThread(r.Context(), threadID); err != nil {
		writeError(w, r, http.StatusBadGateway, "REVIEW_THREAD_RESOLVE_FAILED", err.Error())
		return
	}
	if err := s.store.MarkReviewThreadResolved(r.Context(), claims.AccountID, target.ID, threadID); err != nil {
		if errors.Is(err, cloudpostgres.ErrReviewThreadNotFound) {
			writeError(w, r, http.StatusNotFound, "REVIEW_THREAD_NOT_FOUND", "The review thread does not belong to this worker.")
			return
		}
		s.internalError(w, r, "mark review thread resolved", err)
		return
	}
	payload, _ := json.Marshal(map[string]string{"threadId": threadID, "source": "orchestrator"})
	if _, err := s.events.Append(r.Context(), claims.AccountID, target.ID, "repository.review_thread_resolved", payload); err != nil {
		s.internalError(w, r, "append review thread resolved event", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "threadId": threadID})
}

func sessionHasReviewThread(threads []cloudlocalgh.ReviewThreadObservation, threadID string) bool {
	for _, thread := range threads {
		if thread.ID == threadID {
			return true
		}
	}
	return false
}

func (s *Server) authorizedProjectWorker(
	w http.ResponseWriter,
	r *http.Request,
	action string,
) (cloudworker.Claims, clouddomain.Session, clouddomain.Session, bool) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return cloudworker.Claims{}, clouddomain.Session{}, clouddomain.Session{}, false
	}
	targetID, validTarget := sessionIDParam(w, r)
	if !validTarget {
		return cloudworker.Claims{}, clouddomain.Session{}, clouddomain.Session{}, false
	}
	target, err := s.store.GetSession(r.Context(), claims.AccountID, targetID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) ||
		err == nil && (target.ProjectID != parent.ProjectID || target.Kind != "worker") {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The project worker does not exist.")
		return cloudworker.Claims{}, clouddomain.Session{}, clouddomain.Session{}, false
	}
	if err != nil {
		s.internalError(w, r, action, err)
		return cloudworker.Claims{}, clouddomain.Session{}, clouddomain.Session{}, false
	}
	return claims, parent, target, true
}

func (s *Server) workerKillSession(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	targetID, validTarget := sessionIDParam(w, r)
	if !validTarget {
		return
	}
	target, err := s.store.GetSession(r.Context(), claims.AccountID, targetID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) ||
		err == nil && (target.ProjectID != parent.ProjectID || target.Kind != "worker") {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The project worker does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "authorize worker deletion", err)
		return
	}
	sandbox, err := s.store.GetSandbox(r.Context(), claims.AccountID, target.ID)
	if err != nil {
		s.internalError(w, r, "load worker sandbox for deletion", err)
		return
	}
	if sandbox.DesiredState == "deleted" {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "state": "deleted"})
		return
	}
	if err := s.store.SetSandboxDesiredState(r.Context(), claims.AccountID, target.ID, "deleted"); err != nil {
		s.internalError(w, r, "delete worker sandbox", err)
		return
	}
	if _, err := s.store.TransitionActiveTurn(r.Context(), claims.AccountID, target.ID, "failed", "Worker machine deleted."); err != nil {
		s.internalError(w, r, "finish deleted worker turn", err)
		return
	}
	if err := s.store.UpdateSessionActivity(r.Context(), claims.AccountID, target.ID, "idle"); err != nil {
		s.internalError(w, r, "reset deleted worker activity", err)
		return
	}
	payload, _ := json.Marshal(map[string]string{"state": "deleted", "source": "orchestrator"})
	if _, err := s.events.Append(r.Context(), claims.AccountID, target.ID, "sandbox.desired_state_changed", payload); err != nil {
		s.internalError(w, r, "append deleted worker event", err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "state": "deleted"})
}

func (s *Server) workerSendMessage(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	targetID, ok := sessionIDParam(w, r)
	if !ok {
		return
	}
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
	if errors.Is(err, cloudpostgres.ErrActiveTurn) {
		writeError(w, r, http.StatusConflict, "TURN_ACTIVE", "The target session already has a response in progress.")
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

func sessionIDParam(w http.ResponseWriter, r *http.Request) (clouddomain.SessionID, bool) {
	value := strings.TrimSpace(chi.URLParam(r, "sessionId"))
	if _, err := uuid.Parse(value); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION_ID", "sessionId must be a UUID.")
		return "", false
	}
	return clouddomain.SessionID(value), true
}

func cloudWorkerHarness(harness string) bool {
	return harness == "claude-code" || harness == "codex" || harness == "cursor"
}

func (s *Server) workerReportBlocker(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:event") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:event scope is required.")
		return
	}
	if strings.TrimSpace(r.Header.Get("X-AO-Session-ID")) != string(claims.SessionID) {
		writeError(w, r, http.StatusForbidden, "SESSION_ID_MISMATCH", "Worker session identity does not match its credential.")
		return
	}
	session, err := s.store.GetSession(r.Context(), claims.AccountID, claims.SessionID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "authorize worker blocker", err)
		return
	}
	if session.Kind != "worker" || session.IsTerminated {
		writeError(w, r, http.StatusForbidden, "WORKER_REQUIRED", "Only an active worker can report a blocker.")
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		writeError(w, r, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.")
		return
	}
	var input struct {
		Message string `json:"message"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Message = strings.TrimSpace(input.Message)
	if input.Message == "" || len([]byte(input.Message)) > 64<<10 {
		writeError(w, r, http.StatusBadRequest, "INVALID_BLOCKER", "message must be non-empty and at most 64 KiB.")
		return
	}
	orchestrator, ok, err := s.projectOrchestrator(r.Context(), claims.AccountID, session.ProjectID)
	if err != nil {
		s.internalError(w, r, "find project orchestrator", err)
		return
	}
	if !ok {
		writeError(w, r, http.StatusConflict, "ORCHESTRATOR_UNAVAILABLE", "No active orchestrator is available for this project.")
		return
	}
	text := fmt.Sprintf("Worker %s (%s) is blocked:\n\n%s", session.DisplayName, session.ID, input.Message)
	event, err := s.events.AppendUserMessage(
		r.Context(),
		claims.AccountID,
		orchestrator.ID,
		"worker-blocker:"+string(session.ID)+":"+idempotencyKey,
		text,
	)
	if errors.Is(err, cloudpostgres.ErrIdempotencyConflict) {
		writeError(w, r, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another command.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrActiveTurn) {
		writeError(w, r, http.StatusConflict, "ORCHESTRATOR_BUSY", "The project orchestrator already has a response in progress.")
		return
	}
	if err != nil {
		s.internalError(w, r, "append worker blocker message", err)
		return
	}
	if err := s.wakeSessionForMessage(r.Context(), claims.AccountID, orchestrator.ID); err != nil {
		s.internalError(w, r, "wake orchestrator for blocker", err)
		return
	}
	if err := s.workerHub.Send(orchestrator.ID, cloudworkerhub.Command{
		Type:     "prompt",
		Data:     base64.StdEncoding.EncodeToString([]byte(text)),
		Sequence: event.Sequence,
	}); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "WORKER_BACKPRESSURE", "The blocker was saved but orchestrator delivery is temporarily unavailable.")
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"orchestratorSessionId": orchestrator.ID,
		"messageSequence":       event.Sequence,
	})
	if _, err := s.events.Append(r.Context(), claims.AccountID, session.ID, "worker.blocker_reported", payload); err != nil {
		s.internalError(w, r, "append worker blocker event", err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func (s *Server) workerClaimOwnPullRequest(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:git") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:git scope is required.")
		return
	}
	if strings.TrimSpace(r.Header.Get("X-AO-Session-ID")) != string(claims.SessionID) {
		writeError(w, r, http.StatusForbidden, "SESSION_ID_MISMATCH", "Worker session identity does not match its credential.")
		return
	}
	session, err := s.store.GetSession(r.Context(), claims.AccountID, claims.SessionID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "authorize worker pull request claim", err)
		return
	}
	if session.Kind != "worker" || session.IsTerminated {
		writeError(w, r, http.StatusForbidden, "WORKER_REQUIRED", "Only an active worker can claim its pull request.")
		return
	}
	if s.localGitHub == nil {
		writeError(w, r, http.StatusNotImplemented, "GITHUB_CONNECTION_REQUIRED", "GitHub is not configured for this deployment.")
		return
	}
	var input struct {
		Reference string `json:"reference"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	project, err := s.store.GetProject(r.Context(), claims.AccountID, session.ProjectID)
	if err != nil {
		s.internalError(w, r, "load project for worker pull request claim", err)
		return
	}
	pull, err := s.localGitHub.GetPullRequest(r.Context(), project.RepositoryURL, input.Reference)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_PULL_REQUEST", "The pull request must belong to this project.")
		return
	}
	claim, err := s.store.ClaimPullRequest(r.Context(), claims.AccountID, clouddomain.PRClaim{
		SessionID:  session.ID,
		Provider:   "github",
		Repository: pull.Repository,
		Number:     pull.Number,
		URL:        pull.URL,
	})
	if errors.Is(err, cloudpostgres.ErrPRClaimed) {
		writeError(w, r, http.StatusConflict, "PR_ALREADY_CLAIMED", "Another active worker already owns this pull request.")
		return
	}
	if err != nil {
		s.internalError(w, r, "claim worker pull request", err)
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"repository": pull.Repository,
		"number":     pull.Number,
		"url":        pull.URL,
		"source":     "worker",
	})
	if _, err := s.events.Append(r.Context(), claims.AccountID, session.ID, "repository.pull_request_claimed", payload); err != nil {
		s.internalError(w, r, "append worker pull request claim event", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"claim": claim})
}

func (s *Server) projectOrchestrator(
	ctx context.Context,
	accountID clouddomain.AccountID,
	projectID clouddomain.ProjectID,
) (clouddomain.Session, bool, error) {
	sessions, err := s.store.ListSessions(ctx, accountID)
	if err != nil {
		return clouddomain.Session{}, false, err
	}
	for _, session := range sessions {
		if session.ProjectID == projectID && session.Kind == "orchestrator" && !session.IsTerminated {
			return session, true, nil
		}
	}
	return clouddomain.Session{}, false, nil
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
		!strings.HasPrefix(input.Type, "workspace_terminal.") &&
		!strings.HasPrefix(input.Type, "repository.") && !strings.HasPrefix(input.Type, "preview.") &&
		!strings.HasPrefix(input.Type, "chat.") {
		writeError(w, r, http.StatusBadRequest, "INVALID_EVENT_TYPE", "Worker event type is not allowed.")
		return
	}
	var activeTurn *clouddomain.Turn
	if strings.HasPrefix(input.Type, "chat.") {
		var err error
		activeTurn, err = s.store.GetActiveTurn(r.Context(), claims.AccountID, claims.SessionID)
		if err != nil {
			s.internalError(w, r, "load worker event turn", err)
			return
		}
		if activeTurn != nil {
			payload := make(map[string]any)
			if len(input.Payload) > 0 && json.Unmarshal(input.Payload, &payload) != nil {
				writeError(w, r, http.StatusBadRequest, "INVALID_CHAT_EVENT", "Chat event payload must be a JSON object.")
				return
			}
			payload["turnId"] = activeTurn.ID
			input.Payload, _ = json.Marshal(payload)
		}
	}
	if input.Type == "worker.prompt_accepted" {
		var acknowledgement struct {
			Sequence int64 `json:"sequence"`
		}
		if json.Unmarshal(input.Payload, &acknowledgement) != nil ||
			acknowledgement.Sequence <= 0 {
			writeError(w, r, http.StatusBadRequest, "INVALID_PROMPT_ACKNOWLEDGEMENT", "Prompt acknowledgement is invalid.")
			return
		}
		if err := s.store.ClaimActiveTurn(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			acknowledgement.Sequence,
			claims.Epoch,
		); err != nil {
			s.internalError(w, r, "claim durable chat turn", err)
			return
		}
	}
	if input.Type == "agent.activity" {
		var activity struct {
			Event       string          `json:"event"`
			State       string          `json:"state"`
			HasActivity bool            `json:"hasActivity"`
			Native      json.RawMessage `json:"native"`
		}
		if err := json.Unmarshal(input.Payload, &activity); err != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_ACTIVITY_EVENT", "Agent activity payload is invalid.")
			return
		}
		if activity.Event == "session-start" {
			nativeSessionID := activityNativeSessionID(activity.Native)
			if nativeSessionID != "" {
				if err := s.store.SetAgentSessionID(
					r.Context(),
					claims.AccountID,
					claims.SessionID,
					nativeSessionID,
				); err != nil {
					s.internalError(w, r, "store agent session ID from activity", err)
					return
				}
			}
			if err := s.workerHub.Send(
				claims.SessionID,
				cloudworkerhub.Command{Type: "agent_ready"},
			); err != nil {
				s.internalError(w, r, "signal worker agent readiness", err)
				return
			}
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
			if activityStartsTurn(activity.Event, activity.State) {
				if _, err := s.store.TransitionActiveTurn(
					r.Context(),
					claims.AccountID,
					claims.SessionID,
					"running",
					"",
				); err != nil {
					s.internalError(w, r, "start turn from worker activity", err)
					return
				}
			}
			if activityCompletesTurn(activity.Event, activity.State) {
				activeTurn, err := s.store.GetActiveTurn(
					r.Context(),
					claims.AccountID,
					claims.SessionID,
				)
				if err != nil {
					s.internalError(w, r, "load turn for worker activity", err)
					return
				}
				if activeTurn != nil && activeTurn.State == "running" {
					if _, err := s.store.TransitionActiveTurn(
						r.Context(),
						claims.AccountID,
						claims.SessionID,
						"completed",
						"",
					); err != nil {
						s.internalError(w, r, "complete turn from worker activity", err)
						return
					}
				}
			}
		}
	}
	if input.Type == "agent.started" {
		if err := s.store.UpdateSessionActivity(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			"idle",
		); err != nil {
			s.internalError(w, r, "reset started agent activity", err)
			return
		}
	}
	switch input.Type {
	case "chat.turn_started":
		if activeTurn != nil {
			if err := s.store.ClaimActiveTurn(
				r.Context(),
				claims.AccountID,
				claims.SessionID,
				activeTurn.UserMessageSequence,
				claims.Epoch,
			); err != nil {
				s.internalError(w, r, "claim started chat turn", err)
				return
			}
		}
		if _, err := s.store.TransitionActiveTurn(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			"running",
			"",
		); err != nil {
			s.internalError(w, r, "start durable chat turn", err)
			return
		}
		if err := s.store.UpdateSessionActivity(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			"active",
		); err != nil {
			s.internalError(w, r, "update chat turn activity", err)
			return
		}
	case "chat.turn_completed", "chat.turn_interrupted", "chat.turn_aborted":
		state := "completed"
		errorMessage := ""
		switch input.Type {
		case "chat.turn_completed":
			var completion struct {
				IsError bool   `json:"isError"`
				Error   string `json:"error"`
			}
			if json.Unmarshal(input.Payload, &completion) == nil && completion.IsError {
				state = "failed"
				errorMessage = completion.Error
			}
		case "chat.turn_aborted":
			state = "failed"
			errorMessage = "agent turn aborted"
		}
		if _, err := s.store.TransitionActiveTurn(
			r.Context(),
			claims.AccountID,
			claims.SessionID,
			state,
			errorMessage,
		); err != nil {
			s.internalError(w, r, "finish durable chat turn", err)
			return
		}
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
	if logWorkerLifecycleEvent(input.Type) {
		s.log.Info("cloud worker lifecycle event",
			"session_id", claims.SessionID,
			"worker_id", claims.WorkerID,
			"worker_epoch", claims.Epoch,
			"event_type", input.Type,
			"event_sequence", event.Sequence,
		)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func activityStartsTurn(event, state string) bool {
	return event == "user-prompt-submit" && state == "active"
}

func activityNativeSessionID(native json.RawMessage) string {
	var payload struct {
		SessionID string `json:"session_id"`
	}
	if json.Unmarshal(native, &payload) != nil {
		return ""
	}
	sessionID := strings.TrimSpace(payload.SessionID)
	if len(sessionID) > 200 {
		return ""
	}
	return sessionID
}

func activityCompletesTurn(event, state string) bool {
	return state == "idle" && (event == "stop" || event == "after-agent")
}

func logWorkerLifecycleEvent(eventType string) bool {
	switch eventType {
	case "worker.prompt_accepted",
		"worker.command_stream_disconnected",
		"repository.ready",
		"agent.started",
		"agent.exited",
		"chat.session_started",
		"chat.turn_started",
		"chat.turn_completed",
		"chat.turn_interrupted",
		"chat.turn_aborted":
		return true
	default:
		return false
	}
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
	s.log.Info("cloud worker command stream connected",
		"session_id", claims.SessionID,
		"worker_id", claims.WorkerID,
		"worker_epoch", claims.Epoch,
		"replay_after", after,
	)
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
	retrySequence, err := s.store.PrepareActiveTurnForWorker(
		r.Context(),
		claims.AccountID,
		claims.SessionID,
		claims.Epoch,
	)
	if err != nil {
		return
	}
	if retrySequence > 0 && retrySequence <= replayedAfter {
		replayedAfter = retrySequence - 1
	}
	if err := s.writePromptReplay(r.Context(), socket, claims, &replayedAfter); err != nil {
		return
	}
	activeTurn, err := s.store.GetActiveTurn(r.Context(), claims.AccountID, claims.SessionID)
	if err != nil {
		return
	}
	if activeTurn != nil && activeTurn.State == "cancel_requested" {
		encoded, _ := json.Marshal(cloudworkerhub.Command{
			Type:     "interrupt",
			Sequence: interrupted,
		})
		if err := s.writeWorkerSocket(r.Context(), socket, encoded); err != nil {
			return
		}
	}
	ticker := time.NewTicker(s.workerReplayWait)
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
			if err := s.writeWorkerSocket(r.Context(), socket, encoded); err != nil {
				s.workerHub.DisconnectAndRequeue(
					claims.SessionID,
					claims.WorkerID,
					claims.Epoch,
					command,
				)
				return
			}
		case <-ticker.C:
			if err := s.writePromptReplay(r.Context(), socket, claims, &replayedAfter); err != nil {
				return
			}
			encoded, _ := json.Marshal(cloudworkerhub.Command{Type: "keepalive"})
			if err := s.writeWorkerSocket(r.Context(), socket, encoded); err != nil {
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
		replayed, err := s.events.ReplayActivePrompts(
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
			var payload struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(event.Payload, &payload) != nil ||
				payload.Text == "" {
				if event.Sequence > *replayedAfter {
					*replayedAfter = event.Sequence
				}
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
			if err := s.writeWorkerSocket(ctx, socket, encoded); err != nil {
				return err
			}
			if event.Sequence > *replayedAfter {
				*replayedAfter = event.Sequence
			}
		}
		if len(replayed) < 500 {
			return nil
		}
	}
}

func (s *Server) writeWorkerSocket(
	ctx context.Context,
	socket *websocket.Conn,
	payload []byte,
) error {
	writeCtx, cancel := context.WithTimeout(ctx, s.workerWriteWait)
	defer cancel()
	return socket.Write(writeCtx, websocket.MessageText, payload)
}

func (s *Server) issueTerminalTicket(w http.ResponseWriter, r *http.Request) {
	account, _ := accountFromContext(r.Context())
	account.ID = tenantAccountIDFromContext(r.Context())
	sessionID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	if _, err := s.store.GetSession(r.Context(), account.ID, sessionID); err != nil {
		if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
			writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
			return
		}
		s.internalError(w, r, "authorize terminal ticket", err)
		return
	}
	var input struct {
		Kind string `json:"kind"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	kind := terminalKind(input.Kind)
	if kind == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_TERMINAL_KIND", "terminal kind must be agent or workspace.")
		return
	}
	scopes := []string{"terminal:read"}
	if org, ok := orgFromContext(r.Context()); !ok || orgRoleAtLeast(org.Membership.Role, "member") {
		scopes = append(scopes, "terminal:operate")
	}
	ticket, err := s.store.IssueAccessTicket(
		r.Context(),
		account.ID,
		sessionID,
		terminalTicketPurpose(kind),
		scopes,
		60*time.Second,
	)
	if err != nil {
		s.internalError(w, r, "issue terminal ticket", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket":    ticket,
		"expiresIn": 60,
		"scopes":    scopes,
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

func terminalKind(value string) string {
	switch value {
	case "", "agent":
		return "agent"
	case "workspace":
		return "workspace"
	default:
		return ""
	}
}

func terminalTicketPurpose(kind string) string {
	if kind == "workspace" {
		return "workspace_terminal"
	}
	return "terminal"
}

func terminalOutputEvent(kind string) string {
	if kind == "workspace" {
		return "workspace_terminal.output"
	}
	return "terminal.output"
}

func ticketHasScope(scopes []string, expected string) bool {
	for _, scope := range scopes {
		if scope == expected {
			return true
		}
	}
	return false
}

func (s *Server) terminalSocket(w http.ResponseWriter, r *http.Request) {
	kind := terminalKind(r.URL.Query().Get("kind"))
	if kind == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_TERMINAL_KIND", "terminal kind must be agent or workspace.")
		return
	}
	ticket, err := s.store.ConsumeAccessTicket(
		r.Context(),
		r.URL.Query().Get("ticket"),
		terminalTicketPurpose(kind),
	)
	if errors.Is(err, cloudpostgres.ErrInvalidTicket) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_TERMINAL_TICKET", "Terminal ticket is invalid or expired.")
		return
	}
	if err != nil {
		s.internalError(w, r, "consume terminal ticket", err)
		return
	}
	canOperateTerminal := ticketHasScope(ticket.Scopes, "terminal:operate")
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
		if event.Type != terminalOutputEvent(kind) && event.Type != "worker.connected" {
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
			if event.Type == terminalOutputEvent(kind) {
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
			if !canOperateTerminal {
				_ = writeTerminalMessage(ctx, socket, terminalServerMessage{
					Type:    "error",
					Message: "Terminal is read-only for viewers.",
				})
				continue
			}
			workerCommand, err := validateTerminalCommand(command)
			if err != nil {
				_ = writeTerminalMessage(ctx, socket, terminalServerMessage{
					Type:    "error",
					Message: err.Error(),
				})
				continue
			}
			if kind == "workspace" {
				workerCommand.Type = "workspace_terminal_" + workerCommand.Type
			}
			if err := s.workerHub.Send(ticket.SessionID, workerCommand); err != nil {
				message := "Terminal command could not be queued."
				if errors.Is(err, cloudworkerhub.ErrWorkerBackpressure) {
					message = "Terminal input queue is full. Wait for the worker to catch up."
				}
				_ = writeTerminalMessage(ctx, socket, terminalServerMessage{
					Type:    "error",
					Message: message,
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

func (s *Server) hasAgentConnection(
	ctx context.Context,
	accountID clouddomain.AccountID,
) (bool, error) {
	connections, err := s.store.ListProviderConnections(ctx, accountID)
	if err != nil {
		return false, err
	}
	for _, connection := range connections {
		if connection.Label != "default" {
			continue
		}
		if _, ok := agentCredentialTypes[connection.Provider]; ok {
			return true, nil
		}
	}
	return false, nil
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
	if r.Context().Err() != nil || errors.Is(err, context.Canceled) {
		return
	}
	s.log.Error("AO Cloud request failed",
		"operation", operation,
		"request_id", middleware.GetReqID(r.Context()),
		"err", err,
	)
	writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error.")
}
