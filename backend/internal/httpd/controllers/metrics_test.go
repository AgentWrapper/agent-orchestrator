package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/observe/metrics"
)

type fakeMetricsProvider struct {
	latest    metrics.Snapshot
	hasLatest bool
	history   []metrics.Snapshot
}

func (f fakeMetricsProvider) Snapshots() ([]metrics.Snapshot, metrics.Snapshot, bool) {
	return f.history, f.latest, f.hasLatest
}

func mountMetrics(p MetricsProvider) http.Handler {
	r := chi.NewRouter()
	(&MetricsController{Provider: p}).Register(r)
	return r
}

func TestMetricsControllerReturnsSnapshot(t *testing.T) {
	snap := metrics.Snapshot{
		CollectedAt: time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC),
		Host:        metrics.Host{NumCPU: 4},
		Zombies:     1,
	}
	h := mountMetrics(fakeMetricsProvider{latest: snap, hasLatest: true, history: []metrics.Snapshot{snap}})

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var resp MetricsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Latest == nil || resp.Latest.Host.NumCPU != 4 || resp.Latest.Zombies != 1 {
		t.Errorf("latest wrong: %+v", resp.Latest)
	}
	if len(resp.History) != 1 {
		t.Errorf("history len = %d, want 1", len(resp.History))
	}
}

func TestMetricsControllerOmitsLatestBeforeFirstTick(t *testing.T) {
	h := mountMetrics(fakeMetricsProvider{hasLatest: false, history: nil})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var resp MetricsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Latest != nil {
		t.Errorf("latest should be omitted before first tick, got %+v", resp.Latest)
	}
	if resp.History == nil {
		t.Errorf("history must serialize as [] not null")
	}
}

func TestMetricsControllerNotImplementedWhenDisabled(t *testing.T) {
	h := mountMetrics(nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", rr.Code)
	}
}
