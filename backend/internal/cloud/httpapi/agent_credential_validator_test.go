package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClaudeCredentialValidatorRejectsUnauthorizedAPIKey(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "invalid-key" {
			t.Fatalf("x-api-key = %q", r.Header.Get("x-api-key"))
		}
		w.WriteHeader(http.StatusUnauthorized)
	})

	err := validator.Validate(
		context.Background(),
		"claude-code",
		"api_key",
		[]byte("invalid-key"),
	)
	if !errors.Is(err, errInvalidAgentCredential) {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestClaudeCredentialValidatorAcceptsAuthenticatedAPIKeyBadRequest(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "valid-key" {
			t.Fatalf("x-api-key = %q", r.Header.Get("x-api-key"))
		}
		w.WriteHeader(http.StatusBadRequest)
	})

	if err := validator.Validate(
		context.Background(),
		"claude-code",
		"api_key",
		[]byte("valid-key"),
	); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestClaudeCredentialValidatorAcceptsSetupTokenShape(t *testing.T) {
	validator := newAgentCredentialValidator(nil)
	token := "sk-ant-oat01-" + strings.Repeat("a", 90)
	if err := validator.Validate(
		context.Background(),
		"claude-code",
		"oauth_token",
		[]byte(token),
	); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestNormalizeAgentCredentialSecretRemovesWrappedWhitespace(t *testing.T) {
	got := string(normalizeAgentCredentialSecret(" sk-ant-oat01-first\n second\t"))
	if got != "sk-ant-oat01-firstsecond" {
		t.Fatalf("normalized secret = %q", got)
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
