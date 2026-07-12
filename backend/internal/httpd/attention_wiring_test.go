package httpd

// Regression coverage for #268 Phase 1: extracting the operator-attention
// derivation into service/attention must preserve the pre-extraction wiring
// contract that a daemon with no session read surface returns 501
// NOT_IMPLEMENTED for GET /api/v1/attention/operator (the projection cannot be
// derived without sessions). Before the fix, attention.New always produced a
// non-nil service, so an unconfigured deps set fell through to a 500 instead.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
)

func TestOperatorAttentionRouteNotImplementedWithoutSessions(t *testing.T) {
	// Empty APIDeps → no Sessions reader → controller must respond 501.
	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{}, ControlDeps{})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/v1/attention/operator")
	if err != nil {
		t.Fatalf("GET /attention/operator: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotImplemented {
		t.Fatalf("GET /attention/operator with no sessions = %d, want 501", resp.StatusCode)
	}
}
