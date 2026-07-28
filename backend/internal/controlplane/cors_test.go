package controlplane

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWithCORS_PreflightAnsweredWithoutAuth(t *testing.T) {
	// Preflight must be answered here (204 + headers) without invoking next —
	// the browser sends no Authorization on OPTIONS, so it must bypass auth.
	nextCalled := false
	h := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { nextCalled = true }))

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/cloud/proxy", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if nextCalled {
		t.Fatal("preflight reached the inner handler; it must short-circuit")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the request origin", got)
	}
	if h := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(h, "Authorization") {
		t.Fatalf("Access-Control-Allow-Headers = %q, must permit Authorization", h)
	}
	if m := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(m, "POST") {
		t.Fatalf("Access-Control-Allow-Methods = %q, must permit POST", m)
	}
}

func TestWithCORS_ActualRequestCarriesHeaderAndReachesHandler(t *testing.T) {
	nextCalled := false
	h := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cloud/proxy", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !nextCalled {
		t.Fatal("actual request did not reach the inner handler")
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("actual response missing reflected origin, got %q", got)
	}
}

func TestWithCORS_NoOriginNoHeaders(t *testing.T) {
	// Same-origin / non-browser callers send no Origin — don't add CORS headers.
	h := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no ACAO header without an Origin, got %q", got)
	}
}
