package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	cloudagentcli "github.com/aoagents/agent-orchestrator/backend/internal/cloud/agentcli"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
)

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "hooks" {
		if len(os.Args) != 4 {
			_, _ = fmt.Fprintln(os.Stderr, "usage: ao hooks <harness> <event>")
			return 1
		}
		baseURL := os.Getenv("AO_CLOUD_PUBLIC_URL")
		token := currentWorkerToken()
		if baseURL == "" || token == "" {
			_, _ = fmt.Fprintln(os.Stderr, "AO_CLOUD_PUBLIC_URL and AO_WORKER_TOKEN are required for hooks")
			return 1
		}
		client := cloudworker.NewClient(baseURL, nil)
		client.SetToken(token)
		if err := cloudworker.ForwardHook(ctx, client, os.Args[2], os.Args[3], os.Stdin); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	command := cloudagentcli.NewCommand(os.Stdout, os.Stderr, workerEnvironment, nil)
	if err := command.ExecuteContext(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			return 0
		}
		_, _ = fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func workerEnvironment(name string) string {
	if name == "AO_WORKER_TOKEN" {
		return currentWorkerToken()
	}
	return os.Getenv(name)
}

func currentWorkerToken() string {
	dataDir := strings.TrimSpace(os.Getenv("AO_DATA_DIR"))
	if dataDir != "" {
		if raw, err := os.ReadFile(filepath.Join(dataDir, "worker-token")); err == nil {
			if token := strings.TrimSpace(string(raw)); token != "" {
				return token
			}
		}
	}
	return strings.TrimSpace(os.Getenv("AO_WORKER_TOKEN"))
}
