package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClaudeCredentialValidatorRejectsUnauthorizedToken(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer invalid-token" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusUnauthorized)
	})

	err := validator.Validate(
		context.Background(),
		"claude-code",
		"oauth_token",
		[]byte("invalid-token"),
	)
	if !errors.Is(err, errInvalidAgentCredential) {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestClaudeCredentialValidatorAcceptsAuthenticatedBadRequest(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
			t.Fatalf("anthropic-beta = %q", r.Header.Get("anthropic-beta"))
		}
		w.WriteHeader(http.StatusBadRequest)
	})

	if err := validator.Validate(
		context.Background(),
		"claude-code",
		"oauth_token",
		[]byte("valid-token"),
	); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func testAgentCredentialValidator(
	t *testing.T,
	handler http.HandlerFunc,
) *agentCredentialValidator {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	validator := newAgentCredentialValidator(server.Client())
	validator.anthropicBaseURL = server.URL
	return validator
}
