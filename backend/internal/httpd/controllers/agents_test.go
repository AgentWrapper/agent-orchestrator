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
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type fakeAgentCatalog struct {
	inventory       agentsvc.Inventory
	refreshed       agentsvc.Inventory
	probed          agentsvc.ProbeResult
	err             error
	listCalls       int
	refreshCalls    int
	probeCalls      int
	probeAgent      string
	models          ports.AgentModelCatalog
	modelCalls      int
	modelAgent      string
	modelProject    string
	modelRefresh    bool
	revalidateCalls int
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

func (f *fakeAgentCatalog) Probe(_ context.Context, agentID string) (agentsvc.ProbeResult, error) {
	f.probeCalls++
	f.probeAgent = agentID
	return f.probed, f.err
}

func (f *fakeAgentCatalog) Models(_ context.Context, agentID, projectID string, refresh bool) (ports.AgentModelCatalog, error) {
	f.modelCalls++
	f.modelAgent = agentID
	f.modelProject = projectID
	f.modelRefresh = refresh
	return f.models, f.err
}

func (f *fakeAgentCatalog) RevalidateModels(_ context.Context, agentID, projectID string) (ports.AgentModelCatalog, error) {
	f.revalidateCalls++
	f.modelAgent = agentID
	f.modelProject = projectID
	return f.models, f.err
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

func TestProbeAgent(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{
		probed: agentsvc.ProbeResult{
			Agent:     agentsvc.Info{ID: "codex", Label: "Codex", AuthStatus: "authorized"},
			Supported: true,
			Installed: true,
		},
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: catalog,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/agents/codex/probe", "")
	if status != http.StatusOK {
		t.Fatalf("POST /agents/codex/probe = %d, body=%s", status, body)
	}
	for _, want := range []string{`"supported":true`, `"installed":true`, `"id":"codex"`, `"authStatus":"authorized"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if catalog.probeCalls != 1 || catalog.probeAgent != "codex" {
		t.Fatalf("probe calls=%d agent=%q, want one codex probe", catalog.probeCalls, catalog.probeAgent)
	}
}

func TestGetAndRefreshAgentModels(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name           string
		method         string
		path           string
		wantRefresh    bool
		wantRevalidate bool
	}{
		{name: "cached", method: http.MethodGet, path: "/api/v1/agents/codex/models?projectId=proj-1"},
		{name: "refresh", method: http.MethodPost, path: "/api/v1/agents/codex/models/refresh?projectId=proj-1", wantRefresh: true},
		{name: "revalidate", method: http.MethodPost, path: "/api/v1/agents/codex/models/refresh?projectId=proj-1&revalidate=true", wantRevalidate: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalog := &fakeAgentCatalog{models: ports.AgentModelCatalog{
				AgentID:       "codex",
				SelectionMode: ports.ModelSelectionCatalog,
				Models:        []ports.AgentModelInfo{{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol"}},
				AllowCustom:   true,
				Source:        "official-catalog",
			}}
			srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Agents: catalog}, httpd.ControlDeps{}))
			defer srv.Close()

			body, status, _ := doRequest(t, srv, tc.method, tc.path, "")
			if status != http.StatusOK {
				t.Fatalf("%s %s = %d, body=%s", tc.method, tc.path, status, body)
			}
			for _, want := range []string{`"agentId":"codex"`, `"selectionMode":"catalog"`, `"id":"gpt-5.6-sol"`} {
				if !strings.Contains(string(body), want) {
					t.Fatalf("body missing %s: %s", want, body)
				}
			}
			wantModelCalls := 1
			if tc.wantRevalidate {
				wantModelCalls = 0
			}
			if catalog.modelCalls != wantModelCalls || catalog.revalidateCalls != btoi(tc.wantRevalidate) || catalog.modelAgent != "codex" || catalog.modelProject != "proj-1" || catalog.modelRefresh != tc.wantRefresh {
				t.Fatalf("model call = count:%d revalidate:%d agent:%q project:%q refresh:%v", catalog.modelCalls, catalog.revalidateCalls, catalog.modelAgent, catalog.modelProject, catalog.modelRefresh)
			}
		})
	}
}

func TestRefreshAgentModelsWithoutCatalogReturnsNotImplemented(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/agents/codex/models/refresh", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("POST refresh without catalog = %d, body=%s", status, body)
	}
	if !strings.Contains(string(body), `"error"`) {
		t.Fatalf("body = %s, want API error envelope", body)
	}
}

func btoi(value bool) int {
	if value {
		return 1
	}
	return 0
}
