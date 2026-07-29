package fly

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

func TestLiveCreateFindGetDelete(t *testing.T) {
	if os.Getenv("AO_FLY_LIVE_TEST") != "1" {
		t.Skip("AO_FLY_LIVE_TEST is not set")
	}
	config := Config{
		BaseURL:     os.Getenv("AO_FLY_API_URL"),
		APIToken:    os.Getenv("AO_FLY_API_TOKEN"),
		AppName:     os.Getenv("AO_FLY_APP"),
		Region:      os.Getenv("AO_FLY_REGION"),
		WorkerImage: os.Getenv("AO_FLY_WORKER_IMAGE"),
	}
	client := New(config)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := client.Validate(ctx); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}

	sessionID := clouddomain.SessionID(uuid.NewString())
	environment, err := client.Create(ctx, cloudsandbox.Spec{
		Name:      "ao-live-" + uuid.NewString()[:8],
		SessionID: sessionID,
		ResourceProfile: clouddomain.ResourceProfile{
			CPU:    1,
			Memory: 1,
			Disk:   10,
		},
		Environment: map[string]string{
			"AO_CLOUD_PUBLIC_URL":       "https://example.invalid",
			"AO_WORKER_BOOTSTRAP_TOKEN": "live-lifecycle-only",
			"AO_WORKSPACE_DIR":          "/workspace/repository",
		},
		Labels: map[string]string{"ao.managed": "true"},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), time.Minute)
		defer cleanupCancel()
		_ = client.Delete(cleanupCtx, environment.ID)
	})
	if environment.ID == "" {
		t.Fatal("Create() returned an empty machine ID")
	}
	found, ok, err := client.FindBySession(ctx, sessionID)
	if err != nil {
		t.Fatalf("FindBySession() error = %v", err)
	}
	if !ok || found.ID != environment.ID {
		t.Fatalf("FindBySession() = (%#v, %v)", found, ok)
	}
	if _, err := client.Get(ctx, environment.ID); err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if err := client.Delete(ctx, environment.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
}
