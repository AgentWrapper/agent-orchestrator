package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("AO worker stopped with an error", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	baseURL := os.Getenv("AO_CLOUD_PUBLIC_URL")
	if baseURL == "" {
		return errors.New("AO_CLOUD_PUBLIC_URL is required")
	}
	client := cloudworker.NewClient(baseURL, nil)
	if len(os.Args) > 1 && os.Args[1] == "hooks" {
		if len(os.Args) != 4 {
			return errors.New("usage: ao hooks <harness> <event>")
		}
		token := os.Getenv("AO_WORKER_TOKEN")
		if token == "" {
			return errors.New("AO_WORKER_TOKEN is required for hooks")
		}
		client.SetToken(token)
		return cloudworker.ForwardHook(ctx, client, os.Args[2], os.Args[3], os.Stdin)
	}
	bootstrapToken := os.Getenv("AO_WORKER_BOOTSTRAP_TOKEN")
	if bootstrapToken == "" {
		return errors.New("AO_WORKER_BOOTSTRAP_TOKEN is required")
	}
	bootstrap, err := client.Bootstrap(ctx, bootstrapToken, cloudworker.Version, cloudworker.DefaultCapabilities)
	_ = os.Unsetenv("AO_WORKER_BOOTSTRAP_TOKEN")
	if err != nil {
		return fmt.Errorf("bootstrap worker: %w", err)
	}
	if err := os.Setenv("AO_WORKER_TOKEN", bootstrap.WorkerToken); err != nil {
		return fmt.Errorf("set worker token environment: %w", err)
	}
	workspaceDir := os.Getenv("AO_WORKSPACE_DIR")
	if workspaceDir == "" {
		workspaceDir = "/workspace/repository"
	}
	dataDir := os.Getenv("AO_DATA_DIR")
	if dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve worker home: %w", err)
		}
		dataDir = filepath.Join(home, ".ao", "worker")
	}
	log.Info("AO worker bootstrapped",
		"session_id", bootstrap.SessionID,
		"worker_id", bootstrap.WorkerID,
		"harness", bootstrap.Launch.Session.Harness,
	)
	return cloudworker.NewRunner(client, bootstrap, workspaceDir, dataDir).Run(ctx)
}
