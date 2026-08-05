package daytona

import (
	"context"
	"os"
	"testing"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

func TestLiveCreateGetDelete(t *testing.T) {
	if os.Getenv("AO_DAYTONA_LIVE_TEST") != "1" {
		t.Skip("AO_DAYTONA_LIVE_TEST is not enabled")
	}
	apiKey := os.Getenv("AO_DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("AO_DAYTONA_API_KEY is not set")
	}
	client := New(
		envOr("AO_DAYTONA_API_URL", "https://app.daytona.io/api"),
		apiKey,
		envOr("AO_DAYTONA_TARGET", "us"),
		nil,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	name := "ao-cloud-e2e-" + time.Now().UTC().Format("20060102-150405")
	environment, err := client.Create(ctx, cloudsandbox.Spec{
		Name:            name,
		SessionID:       "integration-test",
		Snapshot:        "daytona-large",
		ResourceProfile: clouddomain.ResourceProfile{CPU: 4, Memory: 8, Disk: 10},
		Labels: map[string]string{
			"ao.integration_test": "true",
		},
		AutoStopMinutes:   30,
		AutoDeleteMinutes: 60,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), time.Minute)
		defer deleteCancel()
		if err := client.Delete(deleteCtx, environment.ID); err != nil {
			t.Errorf("Delete() cleanup error = %v", err)
		}
	})
	if environment.Resource != (clouddomain.ResourceProfile{CPU: 4, Memory: 8, Disk: 10}) {
		t.Fatalf("resource = %#v", environment.Resource)
	}
	fetched, err := client.Get(ctx, environment.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if fetched.ID != environment.ID {
		t.Fatalf("Get().ID = %q, want %q", fetched.ID, environment.ID)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
