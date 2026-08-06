package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	cloudcommandguard "github.com/aoagents/agent-orchestrator/backend/internal/cloud/commandguard"
)

func TestForwardHookBlocksAutonomousCommandAndPublishesNotice(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("AO_DATA_DIR", dataDir)
	if err := cloudcommandguard.SetEnabled(dataDir, true); err != nil {
		t.Fatal(err)
	}
	var eventType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Type string `json:"type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		eventType = input.Type
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	client := NewClient(server.URL, server.Client())
	payload := bytes.NewBufferString(
		`{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}`,
	)
	err := ForwardHook(context.Background(), client, "claude-code", "pre-tool-use", payload)
	if !errors.Is(err, cloudcommandguard.ErrBlocked) {
		t.Fatalf("ForwardHook() error = %v, want ErrBlocked", err)
	}
	if eventType != "agent.command_guard_blocked" {
		t.Fatalf("worker event type = %q, want agent.command_guard_blocked", eventType)
	}
}

func TestForwardHookBlocksDestructiveGeneratedScript(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("AO_DATA_DIR", dataDir)
	if err := cloudcommandguard.SetEnabled(dataDir, true); err != nil {
		t.Fatal(err)
	}
	client := NewClient("not-a-valid-url", nil)
	payload := bytes.NewBufferString(
		`{"tool_name":"Write","tool_input":{"content":"import shutil\nshutil.rmtree(target)"}}`,
	)
	err := ForwardHook(context.Background(), client, "claude-code", "pre-tool-use", payload)
	if !errors.Is(err, cloudcommandguard.ErrBlocked) {
		t.Fatalf("ForwardHook() error = %v, want ErrBlocked", err)
	}
}
