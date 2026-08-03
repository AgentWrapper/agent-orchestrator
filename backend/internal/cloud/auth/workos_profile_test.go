package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkOSProfileResolverReturnsAndCachesVerifiedProfile(t *testing.T) {
	t.Parallel()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/user_management/users/user_123" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk_test" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id": "user_123",
			"email": "Person@Example.com",
			"first_name": "Ada",
			"last_name": "Lovelace"
		}`))
	}))
	t.Cleanup(server.Close)

	resolver, err := newWorkOSProfileResolver("sk_test", server.URL, server.Client(), time.Minute)
	if err != nil {
		t.Fatalf("newWorkOSProfileResolver() error = %v", err)
	}
	for i := 0; i < 2; i++ {
		profile, err := resolver(context.Background(), "user_123")
		if err != nil {
			t.Fatalf("resolver() error = %v", err)
		}
		if profile.Email != "person@example.com" || profile.DisplayName != "Ada Lovelace" {
			t.Fatalf("profile = %#v", profile)
		}
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestWorkOSProfileResolverRejectsMismatchedUser(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"user_other","email":"person@example.com"}`))
	}))
	t.Cleanup(server.Close)

	resolver, err := newWorkOSProfileResolver("sk_test", server.URL, server.Client(), time.Minute)
	if err != nil {
		t.Fatalf("newWorkOSProfileResolver() error = %v", err)
	}
	if _, err := resolver(context.Background(), "user_123"); err == nil {
		t.Fatal("resolver() error = nil, want mismatched user error")
	}
}
