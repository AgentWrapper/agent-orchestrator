package agentcli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHelpAndVersionDoNotRequireWorkerEnvironment(t *testing.T) {
	for _, test := range []struct {
		args []string
		want string
	}{
		{args: []string{"--help"}, want: "spawn       Spawn a worker"},
		{args: []string{"--version"}, want: "ao " + Version},
	} {
		var output bytes.Buffer
		command := NewCommand(&output, &output, func(string) string { return "" }, nil)
		command.SetArgs(test.args)
		if err := command.Execute(); err != nil {
			t.Fatalf("Execute(%v) error = %v", test.args, err)
		}
		if !strings.Contains(output.String(), test.want) {
			t.Fatalf("Execute(%v) output = %q, want %q", test.args, output.String(), test.want)
		}
	}
}

func TestSpawnUsesWorkerAuthenticatedOrchestrationEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/cloud/v1/worker/orchestrate/sessions" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Worker worker-token" ||
			r.Header.Get("X-AO-Session-ID") != "orchestrator-one" ||
			r.Header.Get("Idempotency-Key") == "" {
			t.Fatalf("request headers = %#v", r.Header)
		}
		var input map[string]string
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatalf("decode input: %v", err)
		}
		if input["displayName"] != "worker one" ||
			input["prompt"] != "fix tests" ||
			input["harness"] != "codex" {
			t.Fatalf("input = %#v", input)
		}
		_, _ = w.Write([]byte(`{"session":{"id":"session-one"},"created":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	command := NewCommand(&output, &output, testEnvironment(server.URL), server.Client())
	command.SetArgs([]string{"spawn", "--name", "worker one", "--prompt", "fix tests", "--agent", "codex"})
	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if output.String() != "session-one\n" {
		t.Fatalf("output = %q", output.String())
	}
}

func TestSendAndStatusProtocols(t *testing.T) {
	var sent bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost &&
			r.URL.Path == "/api/cloud/v1/worker/orchestrate/sessions/worker-one/messages":
			sent = true
			if r.Header.Get("Idempotency-Key") == "" {
				t.Fatal("send omitted Idempotency-Key")
			}
			w.WriteHeader(http.StatusAccepted)
		case r.Method == http.MethodGet &&
			r.URL.Path == "/api/cloud/v1/worker/orchestrate/sessions":
			_, _ = w.Write([]byte(`{"sessions":[{"id":"worker-one","status":"working","kind":"worker","harness":"cursor","displayName":"Worker"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var output bytes.Buffer
	send := NewCommand(&output, &output, testEnvironment(server.URL), server.Client())
	send.SetArgs([]string{"send", "--session", "worker-one", "--message", "continue"})
	if err := send.Execute(); err != nil {
		t.Fatalf("send Execute() error = %v", err)
	}
	if !sent {
		t.Fatal("send endpoint was not called")
	}

	status := NewCommand(&output, &output, testEnvironment(server.URL), server.Client())
	status.SetArgs([]string{"status"})
	if err := status.Execute(); err != nil {
		t.Fatalf("status Execute() error = %v", err)
	}
	if !strings.Contains(output.String(), "worker-one\tworking\tworker\tcursor\tWorker") {
		t.Fatalf("status output = %q", output.String())
	}
}

func TestClientPrefersHeartbeatRefreshedWorkerToken(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "worker-token"), []byte("fresh-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := newClient(func(name string) string {
		return map[string]string{
			"AO_CLOUD_PUBLIC_URL": "https://cloud.example",
			"AO_WORKER_TOKEN":     "bootstrap-token",
			"AO_SESSION_ID":       "orchestrator-one",
			"AO_DATA_DIR":         dataDir,
		}[name]
	}, http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	if client.token != "fresh-token" {
		t.Fatalf("token = %q, want heartbeat-refreshed token", client.token)
	}
}

func testEnvironment(baseURL string) environment {
	return func(name string) string {
		return map[string]string{
			"AO_CLOUD_PUBLIC_URL": baseURL,
			"AO_WORKER_TOKEN":     "worker-token",
			"AO_SESSION_ID":       "orchestrator-one",
		}[name]
	}
}
