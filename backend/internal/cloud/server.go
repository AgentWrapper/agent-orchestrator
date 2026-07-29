package cloud

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
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
	if _, err := secrets.NewLocalEnvelopeManager(cfg.SecretKey, "local-dev"); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	handler := NewHandler(cfg, store, issuer)
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
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		_ = srv.Close()
		return err
	}
	return <-serveErr
}

// NewHandler builds the cloud HTTP surface. Tests call this directly with an
// ephemeral Postgres store.
func NewHandler(cfg Config, store *postgres.Store, issuer *auth.Issuer) http.Handler {
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
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		envelope.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "ao-cloud"})
	})

	projectSvc := projectsvc.NewWithDeps(projectsvc.Deps{Store: store, DefaultHarness: domain.HarnessCodex})
	sessionSvc := sessionsvc.NewWithDeps(sessionsvc.Deps{Manager: cloudCommander{}, Store: store})
	api := httpd.NewAPI(daemonconfig.Config{RequestTimeout: cfg.RequestTimeout}, httpd.APIDeps{
		Projects: projectSvc,
		Sessions: sessionSvc,
		CDC:      store,
		Events:   cdc.NewBroadcaster(),
		EventFilter: func(r *http.Request, e cdc.Event) bool {
			scope, ok := tenancy.ScopeFromContext(r.Context())
			return ok && scope.OrgID != "" && e.OrgID == scope.OrgID
		},
	})
	r.Group(func(r chi.Router) {
		r.Use(tenancy.Middleware(issuer))
		api.Register(r)
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
