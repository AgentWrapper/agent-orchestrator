package fly

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

func TestNewUsesDefaults(t *testing.T) {
	client := New(Config{})
	if client.baseURL != DefaultBaseURL {
		t.Fatalf("baseURL = %q, want %q", client.baseURL, DefaultBaseURL)
	}
	if client.client == nil {
		t.Fatal("HTTP client is nil")
	}
}

func TestCreateMapsSpecToVolumeAndMachine(t *testing.T) {
	var requestNumber int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestNumber++
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("Content-Type = %q", got)
		}
		switch requestNumber {
		case 1:
			if r.Method != http.MethodPost || r.URL.EscapedPath() != "/apps/app%2Fone/volumes" {
				t.Fatalf("volume request = %s %s", r.Method, r.URL.EscapedPath())
			}
			var body struct {
				Name      string `json:"name"`
				Region    string `json:"region"`
				SizeGB    int    `json:"size_gb"`
				Encrypted bool   `json:"encrypted"`
			}
			decodeRequest(t, r, &body)
			if body.Name != "ao_d93472bc65732604" ||
				body.Region != "ord" ||
				body.SizeGB != 10 ||
				!body.Encrypted {
				t.Fatalf("volume body = %#v", body)
			}
			writeJSON(t, w, http.StatusCreated, volumeResponse{
				ID:        "vol/one",
				Name:      body.Name,
				Region:    "ord",
				SizeGB:    10,
				Encrypted: true,
			})
		case 2:
			if r.Method != http.MethodPost || r.URL.EscapedPath() != "/apps/app%2Fone/machines" {
				t.Fatalf("machine request = %s %s", r.Method, r.URL.EscapedPath())
			}
			var body struct {
				Name   string        `json:"name"`
				Region string        `json:"region"`
				Config machineConfig `json:"config"`
			}
			decodeRequest(t, r, &body)
			if body.Name != "ao-session-one" || body.Region != "ord" {
				t.Fatalf("machine placement = %#v", body)
			}
			if body.Config.Image != "registry.example/ao-worker:latest" {
				t.Fatalf("image = %q", body.Config.Image)
			}
			if body.Config.Env["TICKET"] != "ticket-one" {
				t.Fatalf("env = %#v", body.Config.Env)
			}
			if body.Config.Metadata["custom"] != "label" ||
				body.Config.Metadata["ao.session_id"] != "session-one" {
				t.Fatalf("metadata = %#v", body.Config.Metadata)
			}
			if body.Config.Guest != (machineGuest{CPUKind: "shared", CPUs: 4, MemoryMB: 8192}) {
				t.Fatalf("guest = %#v", body.Config.Guest)
			}
			if len(body.Config.Mounts) != 1 ||
				body.Config.Mounts[0].Volume != "vol/one" ||
				body.Config.Mounts[0].Path != "/workspace" {
				t.Fatalf("mounts = %#v", body.Config.Mounts)
			}
			if body.Config.Restart.Policy != "no" {
				t.Fatalf("restart = %#v", body.Config.Restart)
			}
			writeJSON(t, w, http.StatusCreated, machineResponse{
				ID:     "machine-one",
				Name:   body.Name,
				State:  "started",
				Region: body.Region,
				Config: body.Config,
			})
		default:
			t.Fatalf("unexpected request %d: %s %s", requestNumber, r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := testClient(server)
	specLabels := map[string]string{
		"custom":        "label",
		"ao.session_id": "incorrect",
	}
	environment, err := client.Create(context.Background(), cloudsandbox.Spec{
		Name:      "ao-session-one",
		SessionID: "session-one",
		ResourceProfile: clouddomain.ResourceProfile{
			CPU:    4,
			Memory: 8,
			Disk:   99,
		},
		Image:       "ignored-spec-image",
		Environment: map[string]string{"TICKET": "ticket-one"},
		Labels:      specLabels,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if requestNumber != 2 {
		t.Fatalf("requests = %d, want 2", requestNumber)
	}
	if specLabels["ao.session_id"] != "incorrect" {
		t.Fatalf("Create mutated labels: %#v", specLabels)
	}
	want := cloudsandbox.Environment{
		ID:           "machine-one",
		Name:         "ao-session-one",
		State:        "started",
		DesiredState: "started",
		Target:       "ord",
		Resource:     clouddomain.ResourceProfile{CPU: 4, Memory: 8, Disk: 10},
	}
	if environment != want {
		t.Fatalf("environment = %#v, want %#v", environment, want)
	}
}

func TestCreateDeletesVolumeWhenMachineCreationFails(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.EscapedPath())
		switch len(requests) {
		case 1:
			writeJSON(t, w, http.StatusCreated, volumeResponse{ID: "vol/cleanup"})
		case 2:
			http.Error(w, `{"error":"capacity unavailable"}`, http.StatusServiceUnavailable)
		case 3:
			if r.Method != http.MethodDelete || r.URL.EscapedPath() != "/apps/app%2Fone/volumes/vol%2Fcleanup" {
				t.Fatalf("cleanup request = %s %s", r.Method, r.URL.EscapedPath())
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request %d", len(requests))
		}
	}))
	defer server.Close()

	_, err := testClient(server).Create(context.Background(), cloudsandbox.Spec{
		Name:      "sandbox",
		SessionID: "session",
	})
	if err == nil || !strings.Contains(err.Error(), "capacity unavailable") {
		t.Fatalf("Create() error = %v", err)
	}
	if len(requests) != 3 {
		t.Fatalf("requests = %#v", requests)
	}
}

func TestCreatePreservesMachineFailureWhenVolumeCleanupFails(t *testing.T) {
	var requestNumber int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestNumber++
		switch requestNumber {
		case 1:
			writeJSON(t, w, http.StatusCreated, volumeResponse{ID: "vol-one"})
		case 2:
			http.Error(w, "machine failed", http.StatusBadGateway)
		case 3:
			http.Error(w, "cleanup failed", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected request %d", requestNumber)
		}
	}))
	defer server.Close()

	_, err := testClient(server).Create(context.Background(), cloudsandbox.Spec{})
	if err == nil || !strings.Contains(err.Error(), "machine failed") {
		t.Fatalf("Create() error = %v", err)
	}
	if strings.Contains(err.Error(), "cleanup failed") {
		t.Fatalf("Create() replaced primary failure: %v", err)
	}
}

func TestGetTranslatesFlyStateAndResources(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet ||
			r.URL.EscapedPath() != "/apps/app%2Fone/machines/machine%2Fone" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		writeJSON(t, w, http.StatusOK, machineResponse{
			ID:     "machine/one",
			Name:   "sandbox-one",
			State:  "suspended",
			Region: "iad",
			Config: machineConfig{
				Guest:  machineGuest{CPUKind: "shared", CPUs: 2, MemoryMB: 3072},
				Mounts: []machineMount{{Volume: "vol-one", Path: "/workspace", SizeGB: 12}},
			},
		})
	}))
	defer server.Close()

	environment, err := testClient(server).Get(context.Background(), "machine/one")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if environment.State != "paused" ||
		environment.DesiredState != "paused" ||
		environment.Target != "iad" ||
		environment.Resource != (clouddomain.ResourceProfile{CPU: 2, Memory: 3, Disk: 12}) {
		t.Fatalf("environment = %#v", environment)
	}
}

func TestFindBySessionListsAndMatchesMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.EscapedPath() != "/apps/app%2Fone/machines" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		writeJSON(t, w, http.StatusOK, []machineResponse{
			{
				ID:    "other",
				State: "started",
				Config: machineConfig{
					Metadata: map[string]string{"ao.session_id": "other-session"},
				},
			},
			{
				ID:     "matching",
				Name:   "matching-machine",
				State:  "started",
				Region: "ord",
				Config: machineConfig{
					Metadata: map[string]string{"ao.session_id": "wanted-session"},
					Guest:    machineGuest{CPUs: 1, MemoryMB: 1024},
				},
			},
		})
	}))
	defer server.Close()

	environment, found, err := testClient(server).FindBySession(context.Background(), "wanted-session")
	if err != nil {
		t.Fatalf("FindBySession() error = %v", err)
	}
	if !found || environment.ID != "matching" || environment.Name != "matching-machine" {
		t.Fatalf("environment = %#v, found = %v", environment, found)
	}
}

func TestFindBySessionReturnsFalseWithoutMatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusOK, []machineResponse{{ID: "other"}})
	}))
	defer server.Close()

	environment, found, err := testClient(server).FindBySession(context.Background(), "missing")
	if err != nil || found || environment != (cloudsandbox.Environment{}) {
		t.Fatalf("environment = %#v, found = %v, error = %v", environment, found, err)
	}
}

func TestLifecycleMapsActionsAndEscapesMachineID(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q", r.Method)
		}
		paths = append(paths, r.URL.EscapedPath())
		writeJSON(t, w, http.StatusOK, map[string]bool{"ok": true})
	}))
	defer server.Close()

	client := testClient(server)
	operations := []struct {
		name string
		call func(context.Context, cloudsandbox.ID) error
	}{
		{name: "start", call: client.Start},
		{name: "suspend", call: client.Stop},
		{name: "suspend", call: client.Pause},
		{name: "start", call: client.Resume},
	}
	for _, operation := range operations {
		if err := operation.call(context.Background(), "machine/one"); err != nil {
			t.Fatalf("%s error = %v", operation.name, err)
		}
	}
	want := []string{
		"/apps/app%2Fone/machines/machine%2Fone/start",
		"/apps/app%2Fone/machines/machine%2Fone/suspend",
		"/apps/app%2Fone/machines/machine%2Fone/suspend",
		"/apps/app%2Fone/machines/machine%2Fone/start",
	}
	if fmt.Sprint(paths) != fmt.Sprint(want) {
		t.Fatalf("paths = %#v, want %#v", paths, want)
	}
}

func TestDeleteGetsMachineForceDeletesAndCleansMountedVolumes(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.EscapedPath()+"?"+r.URL.RawQuery)
		switch len(requests) {
		case 1:
			writeJSON(t, w, http.StatusOK, machineResponse{
				ID: "machine-one",
				Config: machineConfig{Mounts: []machineMount{
					{Volume: "vol/one", Path: "/workspace"},
					{Volume: "vol-two", Path: "/other"},
					{Volume: "vol/one", Path: "/duplicate"},
					{Path: "/missing-id"},
				}},
			})
		case 2:
			if r.Method != http.MethodDelete || r.URL.Query().Get("force") != "true" {
				t.Fatalf("machine delete = %s %s", r.Method, r.URL.String())
			}
			w.WriteHeader(http.StatusNoContent)
		case 3, 4:
			if r.Method != http.MethodDelete {
				t.Fatalf("volume delete method = %s", r.Method)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request %d", len(requests))
		}
	}))
	defer server.Close()

	if err := testClient(server).Delete(context.Background(), "machine/one"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	want := []string{
		"GET /apps/app%2Fone/machines/machine%2Fone?",
		"DELETE /apps/app%2Fone/machines/machine%2Fone?force=true",
		"DELETE /apps/app%2Fone/volumes/vol%2Fone?",
		"DELETE /apps/app%2Fone/volumes/vol-two?",
	}
	if fmt.Sprint(requests) != fmt.Sprint(want) {
		t.Fatalf("requests = %#v, want %#v", requests, want)
	}
}

func TestDeleteDoesNotRemoveVolumesWhenMachineDeleteFails(t *testing.T) {
	var requestNumber int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestNumber++
		if requestNumber == 1 {
			writeJSON(t, w, http.StatusOK, machineResponse{
				Config: machineConfig{Mounts: []machineMount{{Volume: "vol-one"}}},
			})
			return
		}
		if requestNumber == 2 {
			http.Error(w, "machine is leased", http.StatusConflict)
			return
		}
		t.Fatalf("unexpected volume deletion after machine failure: %s", r.URL.Path)
	}))
	defer server.Close()

	err := testClient(server).Delete(context.Background(), "machine-one")
	if err == nil || !strings.Contains(err.Error(), "machine is leased") {
		t.Fatalf("Delete() error = %v", err)
	}
	if requestNumber != 2 {
		t.Fatalf("request count = %d", requestNumber)
	}
}

func TestDeleteAttemptsAllVolumesAndJoinsFailures(t *testing.T) {
	var requestNumber int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestNumber++
		switch requestNumber {
		case 1:
			writeJSON(t, w, http.StatusOK, machineResponse{
				Config: machineConfig{Mounts: []machineMount{
					{Volume: "vol-one"},
					{Volume: "vol-two"},
				}},
			})
		case 2:
			w.WriteHeader(http.StatusNoContent)
		case 3:
			http.Error(w, "first volume failed", http.StatusInternalServerError)
		case 4:
			http.Error(w, "second volume failed", http.StatusBadGateway)
		default:
			t.Fatalf("unexpected request %d", requestNumber)
		}
	}))
	defer server.Close()

	err := testClient(server).Delete(context.Background(), "machine-one")
	if err == nil ||
		!strings.Contains(err.Error(), "first volume failed") ||
		!strings.Contains(err.Error(), "second volume failed") {
		t.Fatalf("Delete() error = %v", err)
	}
	if requestNumber != 4 {
		t.Fatalf("request count = %d", requestNumber)
	}
}

func TestValidateChecksConfiguredApp(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.EscapedPath() != "/apps/app%2Fone" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q", got)
		}
		writeJSON(t, w, http.StatusOK, map[string]string{"name": "app/one"})
	}))
	defer server.Close()

	if err := testClient(server).Validate(context.Background()); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestNotFoundErrorsUseProviderSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer server.Close()

	client := testClient(server)
	if _, err := client.Get(context.Background(), "missing"); !errors.Is(err, cloudsandbox.ErrNotFound) {
		t.Fatalf("Get() error = %v", err)
	}
	if err := client.Start(context.Background(), "missing"); !errors.Is(err, cloudsandbox.ErrNotFound) {
		t.Fatalf("Start() error = %v", err)
	}
	if err := client.Delete(context.Background(), "missing"); !errors.Is(err, cloudsandbox.ErrNotFound) {
		t.Fatalf("Delete() error = %v", err)
	}
}

func TestHTTPErrorIsBoundedAndDoesNotExposeToken(t *testing.T) {
	const token = "super-secret-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(strings.Repeat("x", maxErrorBytes+1024)))
	}))
	defer server.Close()

	client := testClient(server)
	client.apiToken = token
	err := client.Validate(context.Background())
	if err == nil {
		t.Fatal("Validate() error = nil")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("error exposes token: %v", err)
	}
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("error type = %T, want *HTTPError", err)
	}
	if len(httpErr.Body) != maxErrorBytes {
		t.Fatalf("error body length = %d, want %d", len(httpErr.Body), maxErrorBytes)
	}
}

func TestSuccessResponseSizeIsBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(strings.Repeat(" ", maxResponseBytes+1)))
	}))
	defer server.Close()

	_, err := testClient(server).Get(context.Background(), "machine")
	if err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("Get() error = %v", err)
	}
}

func TestInvalidJSONReturnsDecodeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":`))
	}))
	defer server.Close()

	_, err := testClient(server).Get(context.Background(), "machine")
	if err == nil || !strings.Contains(err.Error(), "decode response") {
		t.Fatalf("Get() error = %v", err)
	}
}

func TestTranslateState(t *testing.T) {
	tests := map[string]struct {
		state   string
		desired string
	}{
		"created":    {state: "creating", desired: "started"},
		"starting":   {state: "starting", desired: "started"},
		"started":    {state: "started", desired: "started"},
		"stopping":   {state: "stopping", desired: "stopped"},
		"stopped":    {state: "stopped", desired: "stopped"},
		"suspending": {state: "pausing", desired: "paused"},
		"suspended":  {state: "paused", desired: "paused"},
		"destroying": {state: "deleting", desired: "deleted"},
		"destroyed":  {state: "deleted", desired: "deleted"},
		"failed":     {state: "failed", desired: "failed"},
	}
	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			if got := translateState(input); got != want.state {
				t.Fatalf("translateState(%q) = %q, want %q", input, got, want.state)
			}
			if got := desiredState(input); got != want.desired {
				t.Fatalf("desiredState(%q) = %q, want %q", input, got, want.desired)
			}
		})
	}
}

func testClient(server *httptest.Server) *Client {
	return New(Config{
		BaseURL:     server.URL,
		APIToken:    "secret",
		AppName:     "app/one",
		Region:      "ord",
		WorkerImage: "registry.example/ao-worker:latest",
		HTTPClient:  server.Client(),
	})
}

func decodeRequest(t *testing.T, r *http.Request, output any) {
	t.Helper()
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(output); err != nil {
		t.Fatalf("decode request: %v", err)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, status int, input any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(input); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}
