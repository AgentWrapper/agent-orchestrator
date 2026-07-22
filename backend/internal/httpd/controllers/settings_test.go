package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

// fakeSettingsStore is an in-memory SettingsStore.
type fakeSettingsStore struct {
	mu     sync.Mutex
	values map[string]string
	getErr error
	setErr error
}

func (f *fakeSettingsStore) GetAppSetting(_ context.Context, key string) (string, error) {
	if f.getErr != nil {
		return "", f.getErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.values[key], nil
}

func (f *fakeSettingsStore) SetAppSetting(_ context.Context, key, value string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.values == nil {
		f.values = map[string]string{}
	}
	f.values[key] = value
	return nil
}

func newSettingsServer(t *testing.T, store *fakeSettingsStore) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Settings: store}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSettingsPipelinesRoundTrip(t *testing.T) {
	store := &fakeSettingsStore{}
	srv := newSettingsServer(t, store)

	// Absent setting reads as disabled.
	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/settings/pipelines", "")
	if status != http.StatusOK {
		t.Fatalf("GET status = %d, want 200 (body %s)", status, body)
	}
	if !strings.Contains(string(body), `"enabled":false`) {
		t.Errorf("GET body = %s, want enabled:false", body)
	}

	// Enable it.
	body, status, _ = doRequest(t, srv, http.MethodPut, "/api/v1/settings/pipelines", `{"enabled":true}`)
	if status != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200 (body %s)", status, body)
	}
	if !strings.Contains(string(body), `"enabled":true`) {
		t.Errorf("PUT body = %s, want enabled:true", body)
	}
	if store.values[controllersPipelinesKey] != "true" {
		t.Errorf("persisted value = %q, want \"true\"", store.values[controllersPipelinesKey])
	}

	// GET now reflects the persisted value.
	body, _, _ = doRequest(t, srv, http.MethodGet, "/api/v1/settings/pipelines", "")
	if !strings.Contains(string(body), `"enabled":true`) {
		t.Errorf("GET after enable = %s, want enabled:true", body)
	}
}

func TestSettingsPipelinesRejectsBadBody(t *testing.T) {
	srv := newSettingsServer(t, &fakeSettingsStore{})
	body, status, _ := doRequest(t, srv, http.MethodPut, "/api/v1/settings/pipelines", `{"enabled":"yes"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("PUT bad body status = %d, want 400 (body %s)", status, body)
	}
}

// controllersPipelinesKey mirrors controllers.PipelinesEnabledSettingKey without
// importing the package under an alias in the external test.
const controllersPipelinesKey = "pipelines.enabled"
