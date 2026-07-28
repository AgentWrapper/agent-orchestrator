package controlplane

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stubAuth is an Authenticator whose result is fixed.
type stubAuth struct{ tenant string }

func (s stubAuth) Authenticate(*http.Request) (string, error) {
	if s.tenant == "" {
		return "", errUnauth
	}
	return s.tenant, nil
}

var errUnauth = &authErr{}

type authErr struct{}

func (*authErr) Error() string { return "no user token" }

func serveBusAuth(a Authenticator, signer *BusTokenSigner, authHeader string) (int, string) {
	var seenTenant string
	h := busAuthMiddleware(a, signer)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seenTenant = TenantFromContext(r.Context())
	}))
	req := httptest.NewRequest("POST", "/api/v1/cloud/bus/event", nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, seenTenant
}

func TestBusAuth_AcceptsUserToken(t *testing.T) {
	code, tenant := serveBusAuth(stubAuth{tenant: "userco"}, nil, "Bearer whatever")
	if code != http.StatusOK || tenant != "userco" {
		t.Fatalf("user token: code=%d tenant=%q", code, tenant)
	}
}

func TestBusAuth_FallsBackToBusToken(t *testing.T) {
	signer := NewBusTokenSigner("k", time.Hour)
	tok, _ := signer.MintForSandbox("sbtenant", "box-1")
	code, tenant := serveBusAuth(stubAuth{}, signer, "Bearer "+tok)
	if code != http.StatusOK || tenant != "sbtenant" {
		t.Fatalf("bus token: code=%d tenant=%q", code, tenant)
	}
}

func TestBusAuth_RejectsGarbage(t *testing.T) {
	signer := NewBusTokenSigner("k", time.Hour)
	code, _ := serveBusAuth(stubAuth{}, signer, "Bearer not-a-real-token")
	if code != http.StatusUnauthorized {
		t.Fatalf("garbage token should 401, got %d", code)
	}
}

func TestBusAuth_RejectsWhenNoSignerAndNoUser(t *testing.T) {
	code, _ := serveBusAuth(stubAuth{}, nil, "Bearer anything")
	if code != http.StatusUnauthorized {
		t.Fatalf("no signer + no user should 401, got %d", code)
	}
}
