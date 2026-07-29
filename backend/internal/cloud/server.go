package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	daemonconfig "github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

// Run starts ao-cloud and blocks until interrupted.
func Run() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	store, err := postgres.Open(cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	issuer, err := auth.NewIssuer(auth.IssuerConfig{Secret: cfg.JWTSecret, Issuer: "ao-cloud"})
	if err != nil {
		return err
	}
	secretManager, err := secrets.NewLocalEnvelopeManager(cfg.SecretKey, "local-dev")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return err
	}
	credentialSvc := credentials.New(store, secretManager)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	events := cdc.NewBroadcaster()
	poller := cdc.NewPoller(store.AdminChangeLogSource(), events, cdc.PollerConfig{Logger: logger})
	if err := poller.SeekToHead(ctx); err != nil {
		return err
	}
	pollerDone := poller.Start(ctx)

	runtimeStack, err := newCloudRuntimeStack(cfg, store, issuer, logger)
	if err != nil {
		return err
	}
	handler := NewHandlerWithRuntime(cfg, store, issuer, credentialSvc, events, runtimeStack)
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	ln, err := net.Listen("tcp", cfg.Addr())
	if err != nil {
		return fmt.Errorf("bind %s: %w", cfg.Addr(), err)
	}
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("ao-cloud listening", "addr", ln.Addr().String())
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()
	select {
	case err := <-serveErr:
		stop()
		<-pollerDone
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		_ = srv.Close()
		return err
	}
	err = <-serveErr
	<-pollerDone
	return err
}

// NewHandler builds the cloud HTTP surface. Tests call this directly with an
// ephemeral Postgres store.
func NewHandler(cfg Config, store *postgres.Store, issuer *auth.Issuer, credentialSvc *credentials.Service, events *cdc.Broadcaster) http.Handler {
	return NewHandlerWithRuntime(cfg, store, issuer, credentialSvc, events, nil)
}

func NewHandlerWithRuntime(cfg Config, store *postgres.Store, issuer *auth.Issuer, credentialSvc *credentials.Service, events *cdc.Broadcaster, runtimeStack *cloudRuntimeStack) http.Handler {
	if events == nil {
		events = cdc.NewBroadcaster()
	}
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	authHandler := &auth.Handler{
		Store:  store,
		Issuer: issuer,
		Google: auth.NewHTTPGoogleProvider(cfg.Google, nil),
	}
	authHandler.Register(r)
	if cfg.DevAuth {
		r.Post("/auth/dev/token", devAuthHandler(store, issuer))
	}
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		envelope.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "ao-cloud"})
	})

	var sessionService *sessionsvc.Service
	activity := controllers.ActivityRecorder(nil)
	if runtimeStack != nil {
		sessionService = runtimeStack.sessions
		activity = runtimeStack.activity
	}
	projectSvc := projectsvc.NewWithDeps(projectsvc.Deps{Store: store, Sessions: sessionService, DefaultHarness: domain.HarnessCodex})
	if sessionService == nil {
		sessionService = sessionsvc.NewWithDeps(sessionsvc.Deps{Manager: cloudCommander{}, Store: store})
	}
	api := httpd.NewAPI(daemonconfig.Config{RequestTimeout: cfg.RequestTimeout}, httpd.APIDeps{
		Projects: projectSvc,
		Sessions: sessionService,
		Activity: activity,
		CDC:      store,
		Events:   events,
		EventFilter: func(r *http.Request, e cdc.Event) bool {
			scope, ok := tenancy.ScopeFromContext(r.Context())
			return ok && scope.OrgID != "" && e.OrgID == scope.OrgID
		},
	})
	r.Group(func(r chi.Router) {
		r.Use(tenancy.Middleware(issuer, store))
		if credentialSvc != nil {
			r.Post("/api/v1/agent-credentials", credentialSvc.CreateHTTP)
		}
		r.Post("/api/v1/cloud/projects", cloudProjectHandler(store))
		if runtimeStack != nil {
			api.Register(r)
		} else {
			api.RegisterReadOnly(r)
		}
	})
	return r
}

type cloudCommander struct{}

func (cloudCommander) Spawn(context.Context, ports.SpawnConfig) (domain.SessionRecord, int, int, error) {
	return domain.SessionRecord{}, 0, 0, errRuntimeUnavailable()
}
func (cloudCommander) RestoreWithMode(context.Context, domain.SessionID) (sessionmanager.RestoreResult, error) {
	return sessionmanager.RestoreResult{}, errRuntimeUnavailable()
}
func (cloudCommander) ResumeAgentWithMode(context.Context, domain.SessionID) (sessionmanager.RestoreResult, error) {
	return sessionmanager.RestoreResult{}, errRuntimeUnavailable()
}
func (cloudCommander) Kill(context.Context, domain.SessionID) (bool, error) {
	return false, errRuntimeUnavailable()
}
func (cloudCommander) RetireForReplacement(context.Context, domain.SessionID) error {
	return errRuntimeUnavailable()
}
func (cloudCommander) Send(context.Context, domain.SessionID, string) error {
	return errRuntimeUnavailable()
}
func (cloudCommander) Cleanup(context.Context, domain.ProjectID) (sessionmanager.CleanupResult, error) {
	return sessionmanager.CleanupResult{}, nil
}
func (cloudCommander) RollbackSpawn(context.Context, domain.SessionID) (bool, bool, error) {
	return false, false, errRuntimeUnavailable()
}

func errRuntimeUnavailable() error {
	return errors.New("ao cloud phase 1 does not include sandbox runtime operations")
}

var _ controllers.SessionService = (*sessionsvc.Service)(nil)

func cloudProjectHandler(store *postgres.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ID            string `json:"id"`
			Name          string `json:"name"`
			RepoURL       string `json:"repoUrl"`
			DefaultBranch string `json:"defaultBranch"`
			WorkerAgent   string `json:"workerAgent"`
			Permissions   string `json:"permissions"`
		}
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
			return
		}
		id := strings.TrimSpace(in.ID)
		repoURL := strings.TrimSpace(in.RepoURL)
		if id == "" || repoURL == "" {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PROJECT_ID_AND_REPO_URL_REQUIRED", "id and repoUrl are required", nil)
			return
		}
		name := strings.TrimSpace(in.Name)
		if name == "" {
			name = id
		}
		worker := domain.AgentHarness(strings.TrimSpace(in.WorkerAgent))
		if worker == "" {
			worker = domain.HarnessClaudeCode
		}
		permissions := domain.PermissionMode(strings.TrimSpace(in.Permissions))
		if permissions == "" {
			permissions = domain.PermissionModeBypassPermissions
		}
		orgID, err := tenancy.OrgIDFromContext(r.Context())
		if err != nil {
			envelope.WriteError(w, r, err)
			return
		}
		cfg := domain.ProjectConfig{
			DefaultBranch: strings.TrimSpace(in.DefaultBranch),
			Env:           map[string]string{"AO_CLOUD_ORG_ID": orgID},
			Worker: domain.RoleOverride{
				Harness:     worker,
				AgentConfig: domain.AgentConfig{Permissions: permissions},
			},
		}
		if err := cfg.Validate(); err != nil {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PROJECT_CONFIG", err.Error(), nil)
			return
		}
		rec := domain.ProjectRecord{
			ID:            id,
			Path:          repoURL,
			RepoOriginURL: repoURL,
			DisplayName:   name,
			RegisteredAt:  time.Now().UTC(),
			Kind:          domain.ProjectKindSingleRepo,
			Config:        cfg,
		}
		if err := store.UpsertProject(r.Context(), rec); err != nil {
			envelope.WriteError(w, r, err)
			return
		}
		envelope.WriteJSON(w, http.StatusCreated, map[string]any{
			"project": map[string]any{
				"id":      rec.ID,
				"name":    rec.DisplayName,
				"repoUrl": rec.RepoOriginURL,
			},
		})
	}
}

func devAuthHandler(store *postgres.Store, issuer *auth.Issuer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		email := strings.TrimSpace(in.Email)
		if email == "" {
			email = "dev@example.com"
		}
		name := strings.TrimSpace(in.Name)
		if name == "" {
			name = "AO Cloud Dev"
		}
		user, orgs, err := store.UpsertGoogleUser(r.Context(), auth.GoogleProfile{
			Subject:     "dev:" + email,
			Email:       email,
			DisplayName: name,
		})
		if err != nil {
			envelope.WriteError(w, r, err)
			return
		}
		orgIDs := make([]string, 0, len(orgs))
		for _, org := range orgs {
			orgIDs = append(orgIDs, org.ID)
		}
		pair, err := issuer.Issue(user.ID, orgIDs)
		if err != nil {
			envelope.WriteError(w, r, err)
			return
		}
		now := time.Now().UTC()
		if err := store.StoreRefreshToken(r.Context(), auth.APIToken{
			ID:        uuid.NewString(),
			UserID:    user.ID,
			TokenHash: auth.HashRefreshToken(pair.RefreshToken),
			Kind:      "refresh",
			ExpiresAt: now.Add(issuer.RefreshTokenTTL()),
			CreatedAt: now,
		}); err != nil {
			envelope.WriteError(w, r, err)
			return
		}
		envelope.WriteJSON(w, http.StatusOK, map[string]any{
			"accessToken":  pair.AccessToken,
			"refreshToken": pair.RefreshToken,
			"expiresAt":    pair.ExpiresAt,
			"user":         user,
			"orgs":         orgs,
		})
	}
}
