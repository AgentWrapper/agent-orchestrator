package cloud

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCloudCORSPreflightAllowsLoopbackRendererHeaders(t *testing.T) {
	handler := cloudCORSMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/sessions", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5174")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization,x-ao-org-id,content-type")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5174" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "authorization,x-ao-org-id,content-type" {
		t.Fatalf("Access-Control-Allow-Headers = %q", got)
	}
}

func TestCloudCORSRejectsRemoteOrigins(t *testing.T) {
	handler := cloudCORSMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestCloudMuxQueryAuthMiddlewareMapsTokenAndOrgHeaders(t *testing.T) {
	handler := cloudMuxQueryAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer token-1" {
			t.Fatalf("Authorization = %q", got)
		}
		if got := r.Header.Get("X-AO-Org-ID"); got != "org-1" {
			t.Fatalf("X-AO-Org-ID = %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/mux?access_token=token-1&org_id=org-1", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}
