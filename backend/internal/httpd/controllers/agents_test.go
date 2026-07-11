package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/agenthealth"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

type fakeAgentCatalog struct {
	inventory    agentsvc.Inventory
	refreshed    agentsvc.Inventory
	probed       agentsvc.ProbeResult
	models       agentsvc.ModelAvailabilityResponse
	err          error
	listCalls    int
	refreshCalls int
	probeCalls   int
	probeAgent   string
	modelCalls   int
	modelReq     agentsvc.ModelAvailabilityRequest
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

func (f *fakeAgentCatalog) ModelAvailability(_ context.Context, req agentsvc.ModelAvailabilityRequest) (agentsvc.ModelAvailabilityResponse, error) {
	f.modelCalls++
	f.modelReq = req
	return f.models, f.err
}

type fakeModelPinProjects struct {
	summaries []projectsvc.Summary
	projects  map[domain.ProjectID]projectsvc.GetResult
}

func (f fakeModelPinProjects) List(context.Context) ([]projectsvc.Summary, error) {
	return f.summaries, nil
}

func (f fakeModelPinProjects) Get(_ context.Context, id domain.ProjectID) (projectsvc.GetResult, error) {
	return f.projects[id], nil
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

type fakeAgentHealth struct {
	snap agenthealth.Snapshot
}

func (f fakeAgentHealth) Snapshot() agenthealth.Snapshot { return f.snap }

func TestGetAgentHealth(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	health := fakeAgentHealth{snap: agenthealth.Snapshot{
		CheckedAt: now,
		Harnesses: []agenthealth.HarnessHealth{
			{ID: "codex", Label: "Codex", Health: agenthealth.HealthUnauthorized, Reason: "not authenticated (login expired or logged out)", Remedy: "run `codex login`", ChangedAt: now, CheckedAt: now},
		},
	}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		AgentHealth: health,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/health", "")
	if status != http.StatusOK {
		t.Fatalf("GET /agents/health = %d, body=%s", status, body)
	}
	for _, want := range []string{`"harnesses"`, `"id":"codex"`, `"health":"unauthorized"`, `codex login`, `"checkedAt"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
}

func TestGetAgentModelAvailability(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{models: agentsvc.ModelAvailabilityResponse{
		CheckedAt: time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC),
		Harnesses: []agentsvc.HarnessModels{{
			ID:            "codex",
			Label:         "Codex",
			CatalogSource: agentsvc.ModelCatalogKnownSet,
			Models: []agentsvc.ModelAvailability{{
				Model:  "gpt-5.5-codex",
				Status: agentsvc.ModelStatusUnreachable,
				Reason: "400 model not available",
			}},
		}},
	}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: catalog,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/models", "")
	if status != http.StatusOK {
		t.Fatalf("GET /agents/models = %d, body=%s", status, body)
	}
	for _, want := range []string{`"harnesses"`, `"id":"codex"`, `"model":"gpt-5.5-codex"`, `"status":"unreachable"`, `400 model not available`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if catalog.modelCalls != 1 {
		t.Fatalf("modelCalls=%d, want 1", catalog.modelCalls)
	}
}

func TestGetAgentModelAvailabilityForceBypassesCache(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{models: agentsvc.ModelAvailabilityResponse{Harnesses: []agentsvc.HarnessModels{}}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: catalog,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	_, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/models?force=true", "")
	if status != http.StatusOK {
		t.Fatalf("GET /agents/models?force=true = %d, want 200", status)
	}
	if !catalog.modelReq.Force {
		t.Fatalf("force = false, want true")
	}
}

func TestGetAgentModelAvailabilityIncludesConfiguredPins(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{models: agentsvc.ModelAvailabilityResponse{Harnesses: []agentsvc.HarnessModels{}}}
	cfg := domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{{Harness: domain.HarnessCodex, Model: "gpt-5.5-codex", Weight: 100}},
	}
	projects := fakeModelPinProjects{
		summaries: []projectsvc.Summary{{ID: "ao"}},
		projects: map[domain.ProjectID]projectsvc.GetResult{
			"ao": {Status: "ok", Project: &projectsvc.Project{ID: "ao", Config: &cfg}},
		},
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents:         catalog,
		AgentModelPins: projects,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	_, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/models", "")
	if status != http.StatusOK {
		t.Fatalf("GET /agents/models = %d, want 200", status)
	}
	if len(catalog.modelReq.Pins) != 1 {
		t.Fatalf("pins = %#v, want one configured pin", catalog.modelReq.Pins)
	}
	if got := catalog.modelReq.Pins[0]; got.Harness != domain.HarnessCodex || got.Model != "gpt-5.5-codex" {
		t.Fatalf("pin = %#v, want codex/gpt-5.5-codex", got)
	}
}

func TestGetAgentHealthNotImplementedWhenUnset(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	defer srv.Close()

	_, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/health", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("GET /agents/health with no provider = %d, want 501", status)
	}
}

func TestGetAgentModelAvailabilityNotImplementedWhenUnset(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	defer srv.Close()

	_, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/models", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("GET /agents/models with no catalog = %d, want 501", status)
	}
}
