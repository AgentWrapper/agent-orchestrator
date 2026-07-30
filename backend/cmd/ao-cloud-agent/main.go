package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	cloudagentcli "github.com/aoagents/agent-orchestrator/backend/internal/cloud/agentcli"
)

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	command := cloudagentcli.NewCommand(os.Stdout, os.Stderr, os.Getenv, nil)
	if err := command.ExecuteContext(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
