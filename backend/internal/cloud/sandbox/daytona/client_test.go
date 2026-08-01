package daytona

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

func TestCreateMapsProviderNeutralSpec(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/sandbox" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["target"] != "us" || body["cpu"] != float64(4) || body["memory"] != float64(8) {
			t.Fatalf("body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"sandbox-one",
			"name":"ao-session-one",
			"state":"creating",
			"desiredState":"started",
			"target":"us",
			"cpu":4,
			"memory":8,
			"disk":10
		}`))
	}))
	defer server.Close()

	client := New(server.URL, "secret", "us", server.Client())
	environment, err := client.Create(context.Background(), cloudsandbox.Spec{
		Name:            "ao-session-one",
		SessionID:       "session-one",
		ResourceProfile: clouddomain.DefaultResourceProfile(),
		Labels:          map[string]string{"ao.session_id": "session-one"},
		AutoStopMinutes: 30,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if environment.ID != "sandbox-one" || environment.Resource.Disk != 10 {
		t.Fatalf("environment = %#v", environment)
	}
}

func TestLifecycleEscapesSandboxID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/sandbox/id%2Fwith%2Fslash/stop" {
			t.Fatalf("path = %q", r.URL.EscapedPath())
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := New(server.URL, "secret", "us", server.Client())
	if err := client.Stop(context.Background(), cloudsandbox.ID("id/with/slash")); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
}

func TestBootstrapWorkerUploadsAndLaunchesBinary(t *testing.T) {
	var prepared, uploaded, launched bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sandbox-one/files/upload":
			uploaded = true
			if r.URL.Query().Get("path") != "/home/ao/.local/bin/ao-worker" {
				t.Fatalf("upload path = %q", r.URL.Query().Get("path"))
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatalf("ParseMultipartForm() error = %v", err)
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatalf("FormFile() error = %v", err)
			}
			defer file.Close()
			w.WriteHeader(http.StatusOK)
		case "/sandbox-one/process/execute":
			var input struct {
				Command     string            `json:"command"`
				Environment map[string]string `json:"env"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatalf("decode execute body: %v", err)
			}
			if strings.Contains(input.Command, "mkdir -p") {
				prepared = true
				if !strings.Contains(input.Command, "/home/ao/.ao/worker") ||
					!strings.Contains(input.Command, "/workspace") {
					t.Fatalf("prepare command = %q", input.Command)
				}
			} else {
				launched = true
				if !strings.Contains(input.Command, "/home/ao/.local/bin/ao-worker") ||
					!strings.Contains(input.Command, "/home/ao/.ao/worker.log") {
					t.Fatalf("launch command = %q", input.Command)
				}
				if strings.Contains(input.Command, "/home/ao/.local/bin/ao\"") ||
					strings.Contains(input.Command, "ln -sf") {
					t.Fatalf("worker launch shadowed the AO CLI: %q", input.Command)
				}
				if !strings.Contains(input.Command, "env 'AO_WORKER_BOOTSTRAP_TOKEN=ticket' nohup") {
					t.Fatalf("launch environment command = %q", input.Command)
				}
				if input.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "ticket" {
					t.Fatalf("execute environment = %#v", input.Environment)
				}
			}
			_, _ = w.Write([]byte(`{"exitCode":0,"result":""}`))
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()
	client := New(server.URL, "secret", "us", server.Client()).WithToolboxURL(server.URL)
	if err := client.BootstrapWorker(context.Background(), "sandbox-one", cloudsandbox.WorkerBootstrap{
		Binary: []byte("worker"),
		Environment: map[string]string{
			"AO_WORKER_BOOTSTRAP_TOKEN": "ticket",
		},
	}); err != nil {
		t.Fatalf("BootstrapWorker() error = %v", err)
	}
	if !prepared || !uploaded || !launched {
		t.Fatalf("prepared=%v uploaded=%v launched=%v", prepared, uploaded, launched)
	}
}

func TestRecreateRestartsDaytonaWithFreshWorkerEnvironment(t *testing.T) {
	var getCalls int
	var actions []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/sandbox/sandbox-one":
			getCalls++
			state := "stopped"
			if getCalls > 1 {
				state = "started"
			}
			_, _ = w.Write([]byte(`{"id":"sandbox-one","state":"` + state + `"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandbox/sandbox-one/start":
			actions = append(actions, "start")
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/sandbox-one/process/execute":
			var input struct {
				Command     string            `json:"command"`
				Environment map[string]string `json:"env"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(input.Command, "/usr/local/bin/ao-worker") ||
				input.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "fresh-ticket" {
				t.Fatalf("worker launch = %#v", input)
			}
			actions = append(actions, "launch")
			_, _ = w.Write([]byte(`{"exitCode":0,"result":""}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, "secret", "us", server.Client()).WithToolboxURL(server.URL)
	environment, err := client.Recreate(context.Background(), "sandbox-one", cloudsandbox.Spec{
		Environment: map[string]string{"AO_WORKER_BOOTSTRAP_TOKEN": "fresh-ticket"},
	})
	if err != nil {
		t.Fatalf("Recreate() error = %v", err)
	}
	if environment.ID != "sandbox-one" || !reflect.DeepEqual(actions, []string{"start", "launch"}) {
		t.Fatalf("environment = %#v, actions = %#v", environment, actions)
	}
}

func TestShellEnvironmentSortsAndQuotesValues(t *testing.T) {
	got := shellEnvironment(map[string]string{
		"SECOND": "two words",
		"FIRST":  "value'one",
	})
	want := "env 'FIRST=value'\"'\"'one' 'SECOND=two words' "
	if got != want {
		t.Fatalf("shellEnvironment() = %q, want %q", got, want)
	}
}
