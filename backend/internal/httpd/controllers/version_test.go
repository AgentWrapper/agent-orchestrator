package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/buildinfo"
)

func TestVersionControllerReturnsBuildInfo(t *testing.T) {
	r := chi.NewRouter()
	(&VersionController{}).Register(r)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/version", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct == "" {
		t.Error("missing Content-Type header")
	}

	var resp buildinfo.Info
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The endpoint must report the same resolved provenance the CLI reports.
	if resp.Version != buildinfo.Read().Version {
		t.Errorf("Version = %q, want %q", resp.Version, buildinfo.Read().Version)
	}
	if resp.Version == "" {
		t.Error("Version is empty")
	}
}
