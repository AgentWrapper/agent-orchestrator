package main

import (
	"fmt"
	"os"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud"
)

func main() {
	if err := cloud.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
