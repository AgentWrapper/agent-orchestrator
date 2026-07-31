package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	cloudconfig "github.com/aoagents/agent-orchestrator/backend/internal/cloud/config"
	cloudevents "github.com/aoagents/agent-orchestrator/backend/internal/cloud/events"
	cloudhttp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/httpapi"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudreconcile "github.com/aoagents/agent-orchestrator/backend/internal/cloud/reconcile"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/daytona"
	clouddocker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/docker"
	cloudfly "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/fly"
	cloudsandboxresolve "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandboxresolve"
	cloudscm "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("AO Cloud stopped with an error", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := cloudconfig.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := cloudpostgres.Migrate(ctx, cfg.DatabaseDirectURL); err != nil {
		return err
	}
	store, err := cloudpostgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer store.Close()

	eventService := cloudevents.New(store)
	var authenticator cloudauth.Authenticator
	switch cfg.AuthMode {
	case "local":
		authenticator = cloudauth.NewLocalAuthenticator(store)
	case "supabase", "hosted":
		authenticator = cloudauth.NewVerifier(cfg.SupabaseURL, cfg.SupabaseAnonKey, nil)
	default:
		return errors.New("unsupported AO Cloud authentication mode")
	}
	workerTokens := cloudworker.NewTokenManager(cfg.WorkerSigningKey)
	workerHub := cloudworkerhub.New()
	var localGitHub *cloudlocalgh.Client
	switch {
	case cfg.GitHubToken != "":
		localGitHub = cloudlocalgh.NewWithTokenSource(
			cloudlocalgh.StaticTokenSource(cfg.GitHubToken),
			nil,
		)
	case cfg.AllowLocalGitHub:
		localGitHub = cloudlocalgh.New(nil)
	}
	if localGitHub != nil {
		scmObserver := cloudscm.New(store, localGitHub, eventService, 30*time.Second, log)
		go func() {
			if err := scmObserver.Run(ctx); err != nil {
				log.Error("cloud SCM observer stopped", "err", err)
				stop()
			}
		}()
	}
	secretCipher, err := cloudsecrets.New(cfg.EncryptionKey)
	if err != nil {
		return err
	}
	var daytonaProvider cloudsandbox.Provider
	if cfg.DaytonaAPIKey != "" {
		daytonaProvider = daytona.New(cfg.DaytonaAPIURL, cfg.DaytonaAPIKey, cfg.DaytonaTarget, nil)
	}
	var dockerProvider cloudsandbox.Provider
	if cfg.SandboxProvider == "docker" {
		dockerProvider = clouddocker.New(cfg.DockerWorkerImage)
	}
	var flyProvider cloudsandbox.Provider
	if cfg.SandboxProvider == "fly" {
		flyClient := cloudfly.New(cloudfly.Config{
			BaseURL:     cfg.FlyAPIURL,
			APIToken:    cfg.FlyAPIToken,
			AppName:     cfg.FlyApp,
			Region:      cfg.FlyRegion,
			WorkerImage: cfg.FlyWorkerImage,
		})
		validateCtx, cancelValidate := context.WithTimeout(ctx, 15*time.Second)
		validateErr := flyClient.Validate(validateCtx)
		cancelValidate()
		if validateErr != nil {
			return validateErr
		}
		flyProvider = flyClient
	}
	providerResolver := cloudsandboxresolve.New(
		store,
		secretCipher,
		cfg.DaytonaAPIURL,
		cfg.DaytonaTarget,
		daytonaProvider,
		dockerProvider,
		flyProvider,
	)
	var workerBinary []byte
	if cfg.WorkerBinaryPath != "" {
		workerBinary, err = os.ReadFile(cfg.WorkerBinaryPath)
		if err != nil {
			return err
		}
	}
	reconciler := cloudreconcile.New(
		store,
		providerResolver,
		cfg.PublicURL,
		cfg.DaytonaWorkerSnapshot,
		cfg.DockerWorkerImage,
		cfg.ReconcileInterval,
		workerBinary,
		log,
	)
	go func() {
		if err := reconciler.Run(ctx); err != nil {
			log.Error("sandbox reconciler stopped", "err", err)
			stop()
		}
	}()

	api := cloudhttp.New(
		store,
		eventService,
		authenticator,
		workerTokens,
		secretCipher,
		cfg.SandboxProvider,
		cfg.DaytonaAPIURL,
		cfg.DaytonaTarget,
		workerHub,
		localGitHub,
		cfg.WebPublicURL,
		log,
	)
	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		log.Info("AO Cloud listening", "addr", cfg.ListenAddr)
		err := server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
		return err
	}
	return <-serveErr
}
