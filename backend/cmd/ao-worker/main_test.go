package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
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

func TestWarmWorkerRetriesBootstrapUntilAssigned(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) == 1 {
			http.Error(w, `{"code":"INVALID_BOOTSTRAP"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"workerToken":"worker-token",
			"workerId":"session-one:1",
			"epoch":1,
			"expiresIn":900,
			"sessionId":"session-one",
			"launch":{"session":{"id":"session-one","harness":"claude-code"}}
		}`))
	}))
	defer server.Close()

	bootstrap, err := bootstrapWorker(
		context.Background(),
		cloudworker.NewClient(server.URL, server.Client()),
		"pool-token",
		true,
		time.Millisecond,
		nil,
	)
	if err != nil {
		t.Fatalf("bootstrapWorker() error = %v", err)
	}
	if attempts.Load() != 2 || bootstrap.SessionID != "session-one" {
		t.Fatalf("attempts = %d, bootstrap = %#v", attempts.Load(), bootstrap)
	}
}

func TestColdWorkerDoesNotRetryRejectedBootstrap(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		http.Error(w, "rejected", http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := bootstrapWorker(
		context.Background(),
		cloudworker.NewClient(server.URL, server.Client()),
		"cold-token",
		false,
		time.Millisecond,
		nil,
	)
	if err == nil {
		t.Fatal("bootstrapWorker() error = nil")
	}
	if attempts.Load() != 1 {
		t.Fatalf("attempts = %d, want 1", attempts.Load())
	}
}
