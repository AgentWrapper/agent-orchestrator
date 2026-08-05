package worker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/coder/websocket"

	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

func TestAcceptedWorkerTokenIsPublishedForCloudCLI(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("AO_DATA_DIR", dataDir)
	client := NewClient("https://cloud.example", nil)
	client.acceptToken("renewed-token")

	contents, err := os.ReadFile(filepath.Join(dataDir, "worker-token"))
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "renewed-token" {
		t.Fatalf("worker token file = %q", contents)
	}
	info, err := os.Stat(filepath.Join(dataDir, "worker-token"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("worker token mode = %o, want 600", info.Mode().Perm())
	}
}

func TestRunCommandStreamAdvertisesCommandPromptCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cloud/v1/worker/connect" {
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("after"); got != "42" {
			t.Errorf("after = %q, want 42", got)
		}
		if got := r.URL.Query().Get("commandPrompt"); got != "42" {
			t.Errorf("commandPrompt = %q, want 42", got)
		}
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer socket.Close(websocket.StatusNormalClosure, "test complete")
		if err := socket.Write(
			r.Context(),
			websocket.MessageText,
			[]byte(`{"type":"keepalive"}`),
		); err != nil {
			t.Errorf("write command: %v", err)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	client.acceptToken("worker-token")
	stop := errors.New("stop command stream")
	err := client.RunCommandStream(
		context.Background(),
		42,
		42,
		func(cloudworkerhub.Command) error { return stop },
	)
	if !errors.Is(err, stop) {
		t.Fatalf("RunCommandStream() error = %v, want stop", err)
	}
}
