package controllers_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

type collisionsManager struct {
	projectsvc.Manager
	got domain.ProjectID
	out []projectsvc.Collision
}

func (m *collisionsManager) Collisions(_ context.Context, id domain.ProjectID) ([]projectsvc.Collision, error) {
	m.got = id
	return m.out, nil
}

func TestProjectsAPI_ListCollisions(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := &collisionsManager{out: []projectsvc.Collision{{
		SessionA: "p-1",
		SessionB: "p-2",
		Severity: "hot",
		Files:    []projectsvc.CollisionFile{{Path: "config.go", Ranges: []projectsvc.CollisionRange{{Start: 15, End: 20}}}},
	}}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Projects: mgr,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/projects/p/collisions", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %s", status, body)
	}
	if mgr.got != "p" {
		t.Fatalf("handler passed project id %q, want \"p\"", mgr.got)
	}
	var resp controllers_ListProjectCollisionsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, body)
	}
	if len(resp.Collisions) != 1 || resp.Collisions[0].Severity != "hot" {
		t.Fatalf("unexpected body: %+v", resp.Collisions)
	}
	if resp.Collisions[0].Files[0].Ranges[0].Start != 15 {
		t.Fatalf("range round-trip failed: %+v", resp.Collisions[0].Files)
	}
}

// controllers_ListProjectCollisionsResponse mirrors the wire body so the test
// decodes the JSON without importing the controller's unexported shapes.
type controllers_ListProjectCollisionsResponse struct {
	Collisions []projectsvc.Collision `json:"collisions"`
}

func TestProjectsAPI_ListCollisions_StubWithoutManager(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	_, status, _ := doRequest(t, srv, "GET", "/api/v1/projects/p/collisions", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("nil manager must return 501, got %d", status)
	}
}
