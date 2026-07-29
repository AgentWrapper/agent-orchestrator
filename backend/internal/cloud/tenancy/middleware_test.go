package tenancy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type verifierFunc func(string) (Claims, error)

func (f verifierFunc) VerifyAccessToken(token string) (Claims, error) { return f(token) }

type memberStore struct{}

func (memberStore) IsOrgMember(context.Context, string, string) (bool, error) {
	return false, nil
}

func TestMiddlewareAllowsSessionTokenOnlyForMatchingActivityRoute(t *testing.T) {
	mw := Middleware(verifierFunc(func(token string) (Claims, error) {
		if token != "session-token" {
			t.Fatalf("token = %q", token)
		}
		return Claims{Subject: "session:sess-1", OrgIDs: []string{"org-1"}, SessionID: "sess-1"}, nil
	}), memberStore{})
	nextCalled := false
	next := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		scope, ok := ScopeFromContext(r.Context())
		if !ok || scope.OrgID != "org-1" {
			t.Fatalf("scope = %+v ok=%v", scope, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/sess-1/activity", nil)
	req.Header.Set("Authorization", "Bearer session-token")
	rr := httptest.NewRecorder()
	next.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent || !nextCalled {
		t.Fatalf("status=%d nextCalled=%v", rr.Code, nextCalled)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sessions/sess-2/activity", nil)
	req.Header.Set("Authorization", "Bearer session-token")
	rr = httptest.NewRecorder()
	next.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("mismatched session status=%d, want 403", rr.Code)
	}
}
