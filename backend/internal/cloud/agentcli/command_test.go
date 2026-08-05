package agentcli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
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

func TestIssueSpawnAndSessionCoordinationCommands(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/api/cloud/v1/worker/orchestrate/sessions":
			if r.Method == http.MethodPost {
				var input struct {
					IssueNumber int `json:"issueNumber"`
				}
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Fatal(err)
				}
				if input.IssueNumber != 42 {
					t.Fatalf("issue number = %d", input.IssueNumber)
				}
				_, _ = w.Write([]byte(`{"session":{"id":"worker-one"},"created":true}`))
				return
			}
			_, _ = w.Write([]byte(`{"sessions":[{"id":"worker-one","kind":"worker","displayName":"fixer"}]}`))
		case "/api/cloud/v1/worker/orchestrate/sessions/worker-one/claim-pr":
			var input map[string]string
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input["reference"] != "https://github.com/example/repo/pull/8" {
				t.Fatalf("claim input = %#v", input)
			}
		case "/api/cloud/v1/worker/orchestrate/sessions/worker-one":
			if r.Method != http.MethodDelete {
				t.Fatalf("kill method = %s", r.Method)
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var output bytes.Buffer
	for _, args := range [][]string{
		{"spawn", "--issue", "42"},
		{"session", "claim-pr", "fixer", "https://github.com/example/repo/pull/8"},
		{"session", "kill", "fixer"},
	} {
		command := NewCommand(&output, &output, testEnvironment(server.URL), server.Client())
		command.SetArgs(args)
		if err := command.Execute(); err != nil {
			t.Fatalf("Execute(%v) error = %v", args, err)
		}
	}
	if !strings.Contains(output.String(), "worker-one\n") {
		t.Fatalf("output = %q", output.String())
	}
	if len(requests) != 5 {
		t.Fatalf("requests = %#v", requests)
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
			_, _ = w.Write([]byte(`{"sessions":[{"id":"worker-one","status":"working","kind":"worker","harness":"cursor","displayName":"Worker","branch":"ao/worker-one"}]}`))
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
	if !strings.Contains(
		output.String(),
		"worker-one\tworking\tworker\tcursor\tWorker\tactivity=\truntime=offline\tturn=none\tattempts=0\tbranch=ao/worker-one",
	) {
		t.Fatalf("status output = %q", output.String())
	}
}

func TestInspectAndResultResolveWorkerNames(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cloud/v1/worker/orchestrate/sessions":
			_, _ = w.Write([]byte(`{"sessions":[
				{"id":"orchestrator-one","kind":"orchestrator","displayName":"Orchestrator"},
				{"id":"worker-one","kind":"worker","displayName":"fixer"}
			]}`))
		case "/api/cloud/v1/worker/orchestrate/sessions/worker-one/inspection":
			_, _ = w.Write([]byte(`{
				"session":{
					"id":"worker-one",
					"kind":"worker",
					"displayName":"fixer",
					"branch":"ao/fixer",
					"status":"idle",
					"runtimeConnected":true
				},
				"turn":{"id":"turn-one","state":"completed","attemptCount":1},
				"result":"All tests pass.",
				"resultAvailable":true
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var inspectOutput bytes.Buffer
	inspect := NewCommand(&inspectOutput, &inspectOutput, testEnvironment(server.URL), server.Client())
	inspect.SetArgs([]string{"inspect", "fixer"})
	if err := inspect.Execute(); err != nil {
		t.Fatalf("inspect Execute() error = %v", err)
	}
	for _, expected := range []string{
		"id: worker-one",
		"branch: ao/fixer",
		"runtime: connected",
		"turn: completed",
		"result: available",
	} {
		if !strings.Contains(inspectOutput.String(), expected) {
			t.Fatalf("inspect output = %q, want %q", inspectOutput.String(), expected)
		}
	}

	var resultOutput bytes.Buffer
	result := NewCommand(&resultOutput, &resultOutput, testEnvironment(server.URL), server.Client())
	result.SetArgs([]string{"result", "worker-one"})
	if err := result.Execute(); err != nil {
		t.Fatalf("result Execute() error = %v", err)
	}
	if resultOutput.String() != "All tests pass.\n" {
		t.Fatalf("result output = %q", resultOutput.String())
	}
}

func TestWaitPollsDurableTurnUntilResultIsAvailable(t *testing.T) {
	var inspections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cloud/v1/worker/orchestrate/sessions":
			_, _ = w.Write([]byte(`{"sessions":[{"id":"worker-one","kind":"worker","displayName":"fixer"}]}`))
		case "/api/cloud/v1/worker/orchestrate/sessions/worker-one/inspection":
			attempt := inspections.Add(1)
			if attempt == 1 {
				http.Error(w, "temporary deploy restart", http.StatusBadGateway)
				return
			}
			if attempt < 4 {
				_, _ = w.Write([]byte(`{
					"session":{"id":"worker-one","kind":"worker","displayName":"fixer"},
					"turn":{"id":"turn-one","state":"running"},
					"resultAvailable":false
				}`))
				return
			}
			_, _ = w.Write([]byte(`{
				"session":{"id":"worker-one","kind":"worker","displayName":"fixer"},
				"turn":{"id":"turn-one","state":"completed"},
				"result":"Finished from durable events.",
				"resultAvailable":true
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var output bytes.Buffer
	wait := NewCommand(&output, &output, testEnvironment(server.URL), server.Client())
	wait.SetArgs([]string{"wait", "fixer", "--poll", "100ms", "--timeout", "2s"})
	if err := wait.Execute(); err != nil {
		t.Fatalf("wait Execute() error = %v", err)
	}
	if inspections.Load() != 4 || output.String() != "Finished from durable events.\n" {
		t.Fatalf("inspections = %d, output = %q", inspections.Load(), output.String())
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
