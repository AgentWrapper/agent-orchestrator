package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCurrentWorkerTokenUsesHeartbeatRefreshedToken(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("AO_DATA_DIR", dataDir)
	t.Setenv("AO_WORKER_TOKEN", "startup-token")
	if err := os.WriteFile(
		filepath.Join(dataDir, "worker-token"),
		[]byte("heartbeat-refreshed-token\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	if got := currentWorkerToken(); got != "heartbeat-refreshed-token" {
		t.Fatalf("currentWorkerToken() = %q, want heartbeat-refreshed-token", got)
	}
}

func TestCurrentWorkerTokenFallsBackToEnvironment(t *testing.T) {
	t.Setenv("AO_DATA_DIR", t.TempDir())
	t.Setenv("AO_WORKER_TOKEN", "startup-token")

	if got := currentWorkerToken(); got != "startup-token" {
		t.Fatalf("currentWorkerToken() = %q, want startup-token", got)
	}
}
