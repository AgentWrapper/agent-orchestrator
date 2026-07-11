package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// TestFleetAndProjectPauseRoutes drives the pause/resume + fleet endpoints end
// to end through the real router and a store-backed manager.
func TestFleetAndProjectPauseRoutes(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.UpsertProject(context.Background(), domain.ProjectRecord{
		ID: "mer", Path: "/tmp/mer", RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Projects: projectsvc.New(store),
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	// Fleet starts unpaused.
	var fleet struct {
		Paused bool `json:"paused"`
	}
	body, status, _ := doRequest(t, srv, "GET", "/api/v1/fleet", "")
	if status != http.StatusOK {
		t.Fatalf("GET /fleet status = %d, want 200 (%s)", status, body)
	}
	mustJSON(t, body, &fleet)
	if fleet.Paused {
		t.Fatal("fleet should start unpaused")
	}

	// Pause the fleet.
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/fleet/pause", "")
	if status != http.StatusOK {
		t.Fatalf("POST /fleet/pause status = %d (%s)", status, body)
	}
	mustJSON(t, body, &fleet)
	if !fleet.Paused {
		t.Fatal("fleet should be paused after /fleet/pause")
	}

	// Pause a project.
	var pr struct {
		Project projectsvc.Project `json:"project"`
	}
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects/mer/pause", "")
	if status != http.StatusOK {
		t.Fatalf("POST /projects/mer/pause status = %d (%s)", status, body)
	}
	mustJSON(t, body, &pr)
	if !pr.Project.Paused || pr.Project.PauseState != projectsvc.PauseStatePaused {
		t.Fatalf("paused project = %+v, want paused", pr.Project)
	}

	// Resume it.
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/projects/mer/resume", "")
	if status != http.StatusOK {
		t.Fatalf("POST /projects/mer/resume status = %d (%s)", status, body)
	}
	mustJSON(t, body, &pr)
	if pr.Project.Paused {
		t.Fatalf("resumed project still paused: %+v", pr.Project)
	}

	// Resume the fleet.
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/fleet/resume", "")
	if status != http.StatusOK {
		t.Fatalf("POST /fleet/resume status = %d (%s)", status, body)
	}
	mustJSON(t, body, &fleet)
	if fleet.Paused {
		t.Fatal("fleet should be unpaused after /fleet/resume")
	}

	// Pausing an unknown project is a 404.
	_, status, _ = doRequest(t, srv, "POST", "/api/v1/projects/ghost/pause", "")
	if status != http.StatusNotFound {
		t.Fatalf("pause unknown project status = %d, want 404", status)
	}
}
