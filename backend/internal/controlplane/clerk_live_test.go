package controlplane

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// TestLiveClerkVerify verifies a REAL Clerk-issued JWT through the exact
// production auth path (ClerkAuthenticator → live JWKS → RS256 + issuer check →
// tenant). It is skipped unless AO_TEST_CLERK_JWT + CLERK_JWKS_URL are set, so
// normal `go test` runs are unaffected. Drive it from the e2e harness that mints
// a token via Clerk's Backend API.
func TestLiveClerkVerify(t *testing.T) {
	tok := os.Getenv("AO_TEST_CLERK_JWT")
	jwks := os.Getenv("CLERK_JWKS_URL")
	iss := os.Getenv("CLERK_ISSUER")
	if tok == "" || jwks == "" {
		t.Skip("set AO_TEST_CLERK_JWT + CLERK_JWKS_URL to run the live Clerk check")
	}

	auth, err := NewClerkAuthenticator(context.Background(), jwks, iss)
	if err != nil {
		t.Fatalf("build authenticator: %v", err)
	}

	// Positive: the real token verifies and yields a non-empty tenant.
	rGood := httptest.NewRequest(http.MethodGet, "/", nil)
	rGood.Header.Set("Authorization", "Bearer "+tok)
	tenant, err := auth.Authenticate(rGood)
	if err != nil {
		t.Fatalf("real Clerk token REJECTED by production verifier: %v", err)
	}
	if tenant == "" {
		t.Fatal("verified token produced an empty tenant")
	}
	t.Logf("PASS positive: real Clerk JWT verified via live JWKS → tenant=%q", tenant)

	// Negative: malformed token rejected.
	rGarbage := httptest.NewRequest(http.MethodGet, "/", nil)
	rGarbage.Header.Set("Authorization", "Bearer not.a.real.jwt")
	if _, err := auth.Authenticate(rGarbage); err == nil {
		t.Fatal("SECURITY: malformed token was accepted")
	}
	t.Log("PASS negative: malformed token rejected")

	// Negative: missing token rejected.
	if _, err := auth.Authenticate(httptest.NewRequest(http.MethodGet, "/", nil)); err == nil {
		t.Fatal("SECURITY: missing token was accepted")
	}
	t.Log("PASS negative: missing token rejected")

	// Negative: correct signature but wrong expected issuer rejected.
	if iss != "" {
		badIss, err := NewClerkAuthenticator(context.Background(), jwks, "https://evil.example.com")
		if err != nil {
			t.Fatalf("build wrong-issuer authenticator: %v", err)
		}
		rIss := httptest.NewRequest(http.MethodGet, "/", nil)
		rIss.Header.Set("Authorization", "Bearer "+tok)
		if _, err := badIss.Authenticate(rIss); err == nil {
			t.Fatal("SECURITY: token accepted under a wrong expected issuer")
		}
		t.Log("PASS negative: wrong-issuer verification rejected the token")
	}
}
