package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVerifierUsesSupabaseUserEndpoint(t *testing.T) {
	authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("apikey"); got != "public-key" {
			t.Fatalf("apikey = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer access-token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"6b9e7a20-2da5-4130-872d-571d1967af55",
			"email":"cloud@example.com",
			"user_metadata":{"full_name":"Cloud User"}
		}`))
	}))
	defer authServer.Close()

	verifier := NewVerifier(authServer.URL, "public-key", authServer.Client())
	principal, err := verifier.Verify(context.Background(), "access-token")
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if principal.DisplayName != "Cloud User" {
		t.Fatalf("DisplayName = %q", principal.DisplayName)
	}
}

func TestMiddlewareRejectsMissingBearerToken(t *testing.T) {
	verifier := NewVerifier("https://unused.example", "public-key", nil)
	called := false
	handler := verifier.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
	if called {
		t.Fatal("protected handler was called")
	}
}
