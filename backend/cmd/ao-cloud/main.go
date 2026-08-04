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
	cloudecs "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/ecs"
	cloudsandboxresolve "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandboxresolve"
	cloudscm "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsecs "github.com/aws/aws-sdk-go-v2/service/ecs"
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
	case "workos", "external":
		authConfig := cloudauth.ExternalJWTConfig{
			Provider: cfg.AuthProvider,
			Issuer:   cfg.AuthIssuer,
			Audience: cfg.AuthAudience,
			JWKSURL:  cfg.AuthJWKSURL,
		}
		if cfg.AuthMode == "workos" {
			authConfig.ClientID = cfg.AuthAudience
			authConfig.Audience = ""
			authConfig.ProfileResolver, err = cloudauth.NewWorkOSProfileResolver(cfg.WorkOSAPIKey, nil)
			if err != nil {
				return err
			}
		}
		authenticator, err = cloudauth.NewExternalJWTAuthenticator(authConfig)
		if err != nil {
			return err
		}
	default:
		authenticator = cloudauth.NewLocalAuthenticator(store)
	}
	workerTokens := cloudworker.NewTokenManager(cfg.WorkerSigningKey)
	workerHub := cloudworkerhub.New()
	var githubAppClient *cloudgithubapp.Client
	if cfg.GitHubAuthMode == "github-app" {
		githubAppClient, err = cloudgithubapp.New(cloudgithubapp.Config{
			AppID:         cfg.GitHubAppID,
			PrivateKeyPEM: cfg.GitHubAppPrivateKeyPEM,
		})
		if err != nil {
			return err
		}
	}
	var localGitHub *cloudlocalgh.Client
	switch cfg.GitHubAuthMode {
	case "github-app":
		localGitHub = cloudlocalgh.NewWithTokenSource(
			cloudlocalgh.NewCredentialBroker(store, githubAppClient),
			nil,
		)
	case "local-gh":
		if cfg.GitHubToken != "" {
			localGitHub = cloudlocalgh.NewWithTokenSource(
				cloudlocalgh.StaticTokenSource(cfg.GitHubToken),
				nil,
			)
		} else if cfg.AllowLocalGitHub {
			localGitHub = cloudlocalgh.New(nil)
		}
	}
	var repositoryRefresh cloudhttp.RepositoryRefresh
	if localGitHub != nil {
		observerOptions := make([]cloudscm.ObserverOption, 0, 1)
		if cfg.GitHubAuthMode == "github-app" {
			observerOptions = append(observerOptions, cloudscm.WithGitHubAppMode())
		}
		scmObserver := cloudscm.New(
			store,
			localGitHub,
			eventService,
			30*time.Second,
			log,
			observerOptions...,
		)
		repositoryRefresh = scmObserver.RefreshRepository
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
	var ecsProvider cloudsandbox.Provider
	if cfg.SandboxProvider == "ecs" {
		loadOptions := []func(*awsconfig.LoadOptions) error{}
		if cfg.ECSRegion != "" {
			loadOptions = append(loadOptions, awsconfig.WithRegion(cfg.ECSRegion))
		}
		awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
		if err != nil {
			return err
		}
		ecsProvider, err = cloudecs.New(awsecs.NewFromConfig(awsCfg), cloudecs.Config{
			Cluster:        cfg.ECSCluster,
			TaskDefinition: cfg.ECSTaskDefinition,
			ContainerName:  cfg.ECSContainerName,
			Subnets:        cfg.ECSSubnets,
			SecurityGroups: cfg.ECSSecurityGroups,
			AssignPublicIP: cfg.ECSAssignPublicIP,
		})
		if err != nil {
			return err
		}
	}
	providerResolver := cloudsandboxresolve.New(
		store,
		secretCipher,
		cfg.DaytonaAPIURL,
		cfg.DaytonaTarget,
		daytonaProvider,
		dockerProvider,
		ecsProvider,
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
		cfg.AllowExternalSignup,
		log,
		cloudhttp.WithGitHubApp(cloudhttp.GitHubAppConfig{
			Mode:              cfg.GitHubAuthMode,
			AppID:             cfg.GitHubAppID,
			ClientID:          cfg.GitHubAppClientID,
			AppSlug:           cfg.GitHubAppSlug,
			StateSecret:       []byte(cfg.GitHubAppStateSecret),
			WebhookSecret:     []byte(cfg.GitHubAppWebhookSecret),
			Client:            githubAppClient,
			RepositoryRefresh: repositoryRefresh,
		}),
		cloudhttp.WithMaxActiveSandboxesPerOrg(cfg.MaxActiveSandboxesPerOrg),
		cloudhttp.WithSandboxProviderResolver(providerResolver),
	)
	if cfg.GitHubAuthMode == "github-app" {
		go func() {
			if err := api.RunGitHubWebhookProcessor(ctx); err != nil {
				log.Error("GitHub webhook processor stopped", "err", err)
				stop()
			}
		}()
	}
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
