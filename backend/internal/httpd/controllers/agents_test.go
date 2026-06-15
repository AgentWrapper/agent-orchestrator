package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type fakeAgentCatalog struct {
	inventory agentsvc.Inventory
	err       error
}

func (f fakeAgentCatalog) List(context.Context) (agentsvc.Inventory, error) {
	return f.inventory, f.err
}

func TestListAgents(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: fakeAgentCatalog{inventory: agentsvc.Inventory{
			Supported: []agentsvc.Info{{ID: "claude-code", Label: "Claude Code"}, {ID: "codex", Label: "Codex"}},
			Installed: []agentsvc.Info{{ID: "codex", Label: "Codex"}},
			Counts:    agentsvc.Counts{Supported: 2, Installed: 1},
		}},
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents", "")
	if status != http.StatusOK {
		t.Fatalf("GET /agents = %d, body=%s", status, body)
	}
	for _, want := range []string{`"supported"`, `"installed"`, `"supported":2`, `"installed":1`, `"id":"codex"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
}
