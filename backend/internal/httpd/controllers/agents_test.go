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
	inventory    agentsvc.Inventory
	refreshed    agentsvc.Inventory
	err          error
	listCalls    int
	refreshCalls int
}

func (f *fakeAgentCatalog) List(context.Context) (agentsvc.Inventory, error) {
	f.listCalls++
	return f.inventory, f.err
}

func (f *fakeAgentCatalog) Refresh(context.Context) (agentsvc.Inventory, error) {
	f.refreshCalls++
	if f.refreshed.Supported != nil {
		return f.refreshed, f.err
	}
	return f.inventory, f.err
}

func TestListAgents(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{inventory: agentsvc.Inventory{
		Supported:  []agentsvc.Info{{ID: "claude-code", Label: "Claude Code"}, {ID: "codex", Label: "Codex"}},
		Installed:  []agentsvc.Info{{ID: "codex", Label: "Codex"}},
		Authorized: []agentsvc.Info{{ID: "codex", Label: "Codex"}},
	}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: catalog,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents", "")
	if status != http.StatusOK {
		t.Fatalf("GET /agents = %d, body=%s", status, body)
	}
	for _, want := range []string{`"supported"`, `"installed"`, `"authorized"`, `"id":"codex"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if strings.Contains(string(body), `"counts"`) {
		t.Fatalf("body includes removed counts field: %s", body)
	}
	if catalog.listCalls != 1 || catalog.refreshCalls != 0 {
		t.Fatalf("calls: list=%d refresh=%d, want list=1 refresh=0", catalog.listCalls, catalog.refreshCalls)
	}
}

func TestRefreshAgents(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{
		inventory: agentsvc.Inventory{Supported: []agentsvc.Info{{ID: "codex", Label: "Codex"}}},
		refreshed: agentsvc.Inventory{
			Supported:  []agentsvc.Info{{ID: "codex", Label: "Codex"}},
			Installed:  []agentsvc.Info{{ID: "codex", Label: "Codex"}},
			Authorized: []agentsvc.Info{{ID: "codex", Label: "Codex"}},
		},
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: catalog,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/agents/refresh", "")
	if status != http.StatusOK {
		t.Fatalf("POST /agents/refresh = %d, body=%s", status, body)
	}
	for _, want := range []string{`"supported"`, `"installed"`, `"authorized"`, `"id":"codex"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if catalog.listCalls != 0 || catalog.refreshCalls != 1 {
		t.Fatalf("calls: list=%d refresh=%d, want list=0 refresh=1", catalog.listCalls, catalog.refreshCalls)
	}
}
