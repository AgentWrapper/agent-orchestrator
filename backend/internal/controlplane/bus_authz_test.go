package controlplane

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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

// withScope stamps a bus-token sandbox scope the way busAuthMiddleware would.
func withScope(r *http.Request, tenant, sandbox string) *http.Request {
	ctx := context.WithValue(r.Context(), tenantContextKey{}, tenant)
	ctx = context.WithValue(ctx, busScopeKey{}, sandbox)
	return r.WithContext(ctx)
}

// A scoped bus token may only register under its own daemon id. (Audit #4.)
func TestBusRegister_ScopedTokenCannotImpersonateOtherDaemon(t *testing.T) {
	s, _ := testServer()
	body := `{"daemonId":"victim","sessions":[{"sessionId":"x"}]}`
	req := withScope(httptest.NewRequest("POST", "/api/v1/cloud/bus/register", strings.NewReader(body)), "acme", "attacker")
	rec := httptest.NewRecorder()
	s.busRegister(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("scoped token registering another daemon should 403, got %d", rec.Code)
	}
}

// A scoped bus token may not route to a session it neither owns nor orchestrates. (Audit #5.)
func TestBusRoute_ScopedTokenCannotTargetUnrelatedSession(t *testing.T) {
	s, _ := testServer()
	// A victim worker owned by some other orchestrator.
	s.locations.Register(SessionLocation{SessionID: "sb-victim", TenantID: "acme", Type: LocationSandbox, InSandboxSessionID: "p1", PreviewURL: "u", OrchestratorID: "sb-boss"})
	body := `{"op":"send","sessionId":"sb-victim","message":"hijack"}`
	req := withScope(httptest.NewRequest("POST", "/api/v1/cloud/bus/route", strings.NewReader(body)), "acme", "sb-attacker")
	rec := httptest.NewRecorder()
	s.busRoute(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("scoped token targeting unrelated session should 403, got %d", rec.Code)
	}
}

// The legitimate flows are allowed: an orchestrator to its worker, and a worker
// to its orchestrator.
func TestBusRoute_ScopedTokenReachesOwnWorkerAndOrchestrator(t *testing.T) {
	s, _ := testServer()
	// Orchestrator sb-O; worker sb-W owned by sb-O.
	s.locations.Register(SessionLocation{SessionID: "sb-O", TenantID: "acme", Type: LocationSandbox, InSandboxSessionID: "o1", PreviewURL: "uo"})
	s.locations.Register(SessionLocation{SessionID: "sb-W", TenantID: "acme", Type: LocationSandbox, InSandboxSessionID: "w1", PreviewURL: "uw", OrchestratorID: "sb-O"})

	// Orchestrator -> its worker: allowed.
	if !s.hub.AuthorizeBusTarget("acme", "sb-O", "sb-W") {
		t.Fatal("orchestrator should reach its own worker")
	}
	// Worker -> its orchestrator: allowed.
	if !s.hub.AuthorizeBusTarget("acme", "sb-W", "sb-O") {
		t.Fatal("worker should reach its own orchestrator")
	}
	// Worker -> unrelated: denied.
	if s.hub.AuthorizeBusTarget("acme", "sb-W", "sb-stranger") {
		// sb-stranger unknown -> allowed (routing 404s); use a known unrelated one.
	}
	s.locations.Register(SessionLocation{SessionID: "sb-stranger", TenantID: "acme", Type: LocationSandbox, InSandboxSessionID: "s1", PreviewURL: "us"})
	if s.hub.AuthorizeBusTarget("acme", "sb-W", "sb-stranger") {
		t.Fatal("worker must not reach an unrelated session")
	}
}
