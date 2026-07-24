package previewserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestPreviewServerHelper(t *testing.T) {
	if os.Getenv("AO_PREVIEW_TEST_HELPER") != "1" {
		return
	}
	port, err := strconv.Atoi(os.Getenv("PORT"))
	if err != nil || port <= 0 {
		t.Fatalf("invalid helper PORT %q", os.Getenv("PORT"))
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("preview helper ready")
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>managed preview</title>")
	})}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		t.Fatal(err)
	}
}

func TestManagerStartsIsolatedConfiguredServerAndStopsIt(t *testing.T) {
	workspace := writeLaunchFile(t, []Configuration{helperConfiguration("web", TargetApp)})
	manager := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(manager.Close)

	status, err := manager.Start(context.Background(), "ao-1", workspace, "")
	if err != nil {
		t.Fatalf("Start: %v\nstatus=%+v", err, status)
	}
	if status.State != StateReady || status.Configuration != "web" || status.TargetKind != TargetApp {
		t.Fatalf("status = %+v, want ready web app", status)
	}
	if status.Port <= 0 || !strings.Contains(status.URL, strconv.Itoa(status.Port)) {
		t.Fatalf("status URL/port = %q/%d", status.URL, status.Port)
	}
	resp, err := http.Get(status.URL)
	if err != nil {
		t.Fatalf("GET managed preview: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d", resp.StatusCode)
	}

	stopped, err := manager.Stop(context.Background(), "ao-1")
	if err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if stopped.State != StateStopped {
		t.Fatalf("stopped state = %q", stopped.State)
	}
}

func TestManagerKeepsConcurrentSessionServersIsolated(t *testing.T) {
	workspace := writeLaunchFile(t, []Configuration{helperConfiguration("web", TargetApp)})
	manager := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(manager.Close)

	first, err := manager.Start(context.Background(), domain.SessionID("ao-1"), workspace, "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(context.Background(), domain.SessionID("ao-2"), workspace, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.Port == second.Port || first.URL == second.URL {
		t.Fatalf("session previews collided: first=%+v second=%+v", first, second)
	}
	if manager.Status("ao-1").State != StateReady || manager.Status("ao-2").State != StateReady {
		t.Fatalf("both session servers should remain ready")
	}
}

func TestManagerRequiresNameWhenConfigurationsAreAmbiguous(t *testing.T) {
	workspace := writeLaunchFile(t, []Configuration{
		helperConfiguration("web", TargetApp),
		helperConfiguration("api", TargetAPI),
	})
	manager := New(nil)
	t.Cleanup(manager.Close)

	_, err := manager.Start(context.Background(), "ao-1", workspace, "")
	var serviceErr Error
	if !errors.As(err, &serviceErr) || serviceErr.Code != "PREVIEW_CONFIGURATION_REQUIRED" {
		t.Fatalf("error = %#v, want PREVIEW_CONFIGURATION_REQUIRED", err)
	}

	status, err := manager.Start(context.Background(), "ao-1", workspace, "api")
	if err != nil {
		t.Fatalf("named Start: %v", err)
	}
	if status.TargetKind != TargetAPI {
		t.Fatalf("targetKind = %q, want api", status.TargetKind)
	}
	_, _ = manager.Stop(context.Background(), "ao-1")
}

func TestManagerRejectsMissingConfigAndNonLoopbackURL(t *testing.T) {
	manager := New(nil)
	t.Cleanup(manager.Close)
	_, err := manager.Start(context.Background(), "ao-1", t.TempDir(), "")
	assertPreviewErrorCode(t, err, "PREVIEW_CONFIG_NOT_FOUND")

	cfg := helperConfiguration("web", TargetApp)
	cfg.URL = "https://example.com:${PORT}/"
	workspace := writeLaunchFile(t, []Configuration{cfg})
	_, err = manager.Start(context.Background(), "ao-1", workspace, "")
	assertPreviewErrorCode(t, err, "PREVIEW_CONFIG_INVALID")
}

func helperConfiguration(name string, kind TargetKind) Configuration {
	return Configuration{
		Name:               name,
		RuntimeExecutable:  os.Args[0],
		RuntimeArgs:        []string{"-test.run=^TestPreviewServerHelper$"},
		Port:               0,
		AutoPort:           true,
		URL:                "http://127.0.0.1:${PORT}/",
		TargetKind:         kind,
		Env:                map[string]string{"AO_PREVIEW_TEST_HELPER": "1"},
		ReadyTimeoutMillis: 5000,
	}
}

func writeLaunchFile(t *testing.T, configurations []Configuration) string {
	t.Helper()
	workspace := t.TempDir()
	dir := filepath.Join(workspace, ".ao")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(launchFile{Version: 1, Configurations: configurations})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "launch.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	return workspace
}

func assertPreviewErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var serviceErr Error
	if !errors.As(err, &serviceErr) || serviceErr.Code != code {
		t.Fatalf("error = %#v, want %s", err, code)
	}
}
